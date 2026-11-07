"""Dispatch one pinned cloud trial and retrieve authenticated, private originals.

Requires gh (authenticated repository owner), Python 3.10+, and Node 22+ locally.
The caller may run on Linux/macOS/Windows; the browser runs on a fresh Windows VM.
Default is fixtures only. --collect permits exactly one bounded source attempt.
Run one controller at a time; do not dispatch this workflow separately meanwhile.
"""

import argparse
import base64
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

WORKFLOW = "senate-windows-diagnosis.yml"
QUALIFIED_REF = "senate-browser-qualified-20261106"
QUALIFIED_SHA = "5d750416b27532107517570e6d0b1fae7d406637"
SECRET = "SENATE_EVIDENCE_KEY"


def gh(*args, **kwargs):
    env = dict(os.environ)
    for name in ("GH_DEBUG", "GIT_TRACE", "GIT_TRACE_CURL", "GIT_CURL_VERBOSE"):
        env.pop(name, None)
    return subprocess.run(
        ["gh", *args], env=env, capture_output=True, check=True, timeout=60, **kwargs
    )


def runs(repo):
    return json.loads(
        gh(
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            WORKFLOW,
            "--limit",
            "30",
            "--json",
            "databaseId,headSha,status,conclusion,url,event",
        ).stdout
    )


def unpack(archive, output):
    """Reject escaping, duplicate, linked, or oversized artifact members."""
    with zipfile.ZipFile(archive) as entries:
        files = entries.infolist()
        if len(files) > 1000 or sum(x.file_size for x in files) > 32 * 1024**2:
            raise ValueError("artifact exceeds bounds")
        names = set()
        for item in files:
            p = Path(item.filename)
            if (
                p.is_absolute()
                or ".." in p.parts
                or "\\" in item.filename
                or ":" in item.filename
                or item.filename in names
                or item.file_size > 8 * 1024**2
                or stat.S_ISLNK(item.external_attr >> 16)
            ):
                raise ValueError("unsafe artifact member")
            names.add(item.filename)
        output.mkdir(mode=0o700)
        for item in files:
            if item.is_dir():
                continue
            destination = output / item.filename
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with destination.open("xb") as f:
                f.write(entries.read(item))
            destination.chmod(0o600)


def main(repo, output, collect):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("owner/repository required")
    if output.exists() or output.is_symlink():
        raise ValueError("new private output directory required")
    if not shutil.which("node") or not shutil.which("gh"):
        raise ValueError("Node and authenticated GitHub CLI required")
    current = runs(repo)
    if any(x["status"] != "completed" for x in current):
        raise ValueError("another diagnostic is active; no key or source action made")
    existing = json.loads(gh("secret", "list", "--repo", repo, "--json", "name").stdout)
    if any(x["name"] == SECRET for x in existing):
        raise ValueError("evidence key already exists; refusing to replace it")
    head = (
        gh("api", f"repos/{repo}/commits/{QUALIFIED_REF}", "--jq", ".sha").stdout.decode().strip()
    )
    if head != QUALIFIED_SHA:
        raise ValueError("qualified worker ref does not match verified commit")
    before = {x["databaseId"] for x in current}
    output.mkdir(mode=0o700, parents=False)
    record = dict(
        repository=repo,
        worker_ref=QUALIFIED_REF,
        worker_sha=head,
        collect=collect,
        method="browser",
        platform="windows-2025",
        source_attempt_bound=1 if collect else 0,
        database_access=False,
        key_retained=False,
    )
    temporary = Path(tempfile.mkdtemp(prefix="senate-actions-key-"))
    key = temporary / "key.b64"
    with key.open("xb") as f:
        key.chmod(0o600)
        f.write(base64.b64encode(secrets.token_bytes(32)))
    configured = dispatched = False
    terminal = True
    selected = None
    failure = None
    try:
        gh("secret", "set", SECRET, "--repo", repo, input=key.read_bytes())
        configured = True
        # Treat even an ambiguous dispatch error as potentially queued.
        dispatched = True
        terminal = False
        gh(
            "workflow",
            "run",
            WORKFLOW,
            "--repo",
            repo,
            "--ref",
            QUALIFIED_REF,
            "-f",
            "collect=" + str(collect).lower(),
            "-f",
            "method=browser",
            "-f",
            "platform=windows-2025",
        )
        deadline = time.monotonic() + 1100
        last = None
        while time.monotonic() < deadline:
            candidates = [
                r
                for r in runs(repo)
                if r["databaseId"] not in before
                and r["headSha"] == head
                and r["event"] == "workflow_dispatch"
            ]
            if len(candidates) > 1:
                raise RuntimeError("ambiguous dispatch; stop other callers")
            if candidates:
                selected = candidates[0]
                record["run"] = selected
                if selected["status"] != last:
                    print(json.dumps(selected), flush=True)
                    last = selected["status"]
                if selected["status"] == "completed":
                    terminal = True
                    break
            time.sleep(10)
        if not terminal:
            raise TimeoutError("cloud trial exceeded controller bound")
        run_id = str(selected["databaseId"])
        attempt = json.loads(gh("api", f"repos/{repo}/actions/runs/{run_id}").stdout)["run_attempt"]
        encrypted = output / "encrypted-artifact"
        encrypted.mkdir(mode=0o700)
        gh(
            "run",
            "download",
            run_id,
            "--repo",
            repo,
            "--name",
            f"senate-encrypted-{run_id}-{attempt}",
            "--dir",
            str(encrypted),
        )
        archive = temporary / "evidence.zip"
        code = (
            "const fs=require('node:fs');const key=Buffer.from("
            "fs.readFileSync(process.argv[1],'utf8'),'base64');"
            "try{const p=require(process.argv[2]);fs.writeFileSync(process.argv[4],"
            "p.decrypt(fs.readFileSync(process.argv[3]),key));}finally{key.fill(0)}"
        )
        subprocess.run(
            [
                "node",
                "-e",
                code,
                str(key),
                str(Path(__file__).resolve().with_name("protect.cjs")),
                str(encrypted / "senate-evidence.enc"),
                str(archive),
            ],
            capture_output=True,
            check=True,
            timeout=30,
        )
        unpack(archive, output / "private-evidence")
        record["authenticated_decryption_passed"] = True
        if collect:
            m = json.loads((output / "private-evidence/source/capture/manifest.json").read_text())
            record["source_result"] = {
                k: m.get(k)
                for k in (
                    "complete",
                    "stage",
                    "reason",
                    "acknowledgements",
                    "all_requests_accounted",
                )
            }
            record["source_result"].update(
                reports=len(m["reports"]), indexes=len(m["index_passes"])
            )
            if m.get("complete") is not True or m.get("reason"):
                raise RuntimeError(
                    "source did not qualify; review private originals, do not retry denial"
                )
        if selected["conclusion"] != "success":
            raise RuntimeError("workflow failed; review retained private evidence")
    except Exception as error:
        failure = error
        record["error_type"] = type(error).__name__
    finally:
        if dispatched and not terminal:
            # Cancel only this controller's new qualified-worker dispatches.
            try:
                pending = [
                    r
                    for r in runs(repo)
                    if r["databaseId"] not in before
                    and r["headSha"] == head
                    and r["event"] == "workflow_dispatch"
                ]
                if len(pending) != 1:
                    # An ambiguous dispatch might not yet be visible: preserve key.
                    raise RuntimeError("dispatch terminal state unestablished")
                for r in pending:
                    if r["status"] != "completed":
                        gh("run", "cancel", str(r["databaseId"]), "--repo", repo)
                end = time.monotonic() + 90
                while time.monotonic() < end:
                    states = {r["databaseId"]: r["status"] for r in runs(repo)}
                    if all(states.get(r["databaseId"]) == "completed" for r in pending):
                        terminal = True
                        break
                    time.sleep(5)
            except Exception:
                pass
        if configured and terminal:
            try:
                gh("secret", "delete", SECRET, "--repo", repo)
                record["one_time_repository_secret_deleted"] = True
            except Exception:
                record["secret_cleanup_required"] = True
                failure = failure or RuntimeError("secret cleanup failed")
        if terminal:
            shutil.rmtree(temporary)
            record["ephemeral_local_key_directory_removed"] = True
        else:
            # Never destroy an in-flight job's only artifact decryption key.
            record.update(
                key_retained=True,
                recovery_key_directory=str(temporary),
                active_run_cleanup_required=True,
            )
        (output / "RESULT.json").write_text(json.dumps(record, indent=2) + "\n")
        (output / "RESULT.json").chmod(0o600)
    if failure:
        raise RuntimeError(
            "Trial incomplete; review RESULT.json and resolve cleanup before another run"
        ) from None
    print(json.dumps(record), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="treyhuffine/congressional-disclosures-senate-test")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--collect", action="store_true", help="one live attempt after fixtures")
    args = parser.parse_args()
    main(args.repo, args.output.resolve(), args.collect)
