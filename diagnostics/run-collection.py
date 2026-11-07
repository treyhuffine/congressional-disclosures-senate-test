"""One all-report cloud attempt, free local OCR, authenticated private retrieval.

Caller requires Python, Node and authenticated GitHub CLI. No browser, OCR binary,
credentials file or database is needed on the caller. No source request by default.
"""

import argparse
import base64
import importlib.util
import json
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("trial", HERE / "run-trial.py")
trial = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trial)
WORKFLOW = "senate-all-reports.yml"
SECRET = "SENATE_EVIDENCE_KEY"


def runs(repo):
    return json.loads(
        trial.gh(
            "run",
            "list",
            "--repo",
            repo,
            "--workflow",
            WORKFLOW,
            "--limit",
            "30",
            "--json",
            "databaseId,headSha,event,status,conclusion,url",
        ).stdout
    )


def main(args):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise ValueError("owner/repository required")
    if not re.fullmatch("[0-9a-f]{40}", args.expected_sha):
        raise ValueError("immutable expected worker commit required")
    lower, upper = date.fromisoformat(args.lower), date.fromisoformat(args.upper)
    if not 0 <= (upper - lower).days < 31 or not 1 <= args.max_reports <= 1000:
        raise ValueError("bounded date/report plan required")
    current = runs(args.repo)
    if any(r["status"] != "completed" for r in current):
        raise ValueError("another collection is active")
    existing = json.loads(trial.gh("secret", "list", "--repo", args.repo, "--json", "name").stdout)
    if any(s["name"] == SECRET for s in existing):
        raise ValueError("evidence key exists; refusing to replace it")
    head = (
        trial.gh("api", f"repos/{args.repo}/commits/{args.ref}", "--jq", ".sha")
        .stdout.decode()
        .strip()
    )
    if head != args.expected_sha:
        raise ValueError("remote worker ref changed")
    output = args.output.resolve()
    output.mkdir(mode=0o700)
    before = {r["databaseId"] for r in current}
    temporary = Path(tempfile.mkdtemp(prefix="senate-all-key-"))
    key = temporary / "key.b64"
    with key.open("xb") as f:
        key.chmod(0o600)
        f.write(base64.b64encode(secrets.token_bytes(32)))
    record = dict(
        repository=args.repo,
        workflow=WORKFLOW,
        ref=args.ref,
        worker_sha=head,
        lower=args.lower,
        upper=args.upper,
        max_reports=args.max_reports,
        collect=args.collect,
        source_attempt_bound=int(args.collect),
        paid_provider_calls=False,
        source_retry_count=0,
        browser_host="windows-2025",
        extraction_host="ubuntu-24.04",
        key_retained=False,
    )
    configured = dispatched = retrieved = False
    terminal = True
    selected = None
    failure = None
    try:
        trial.gh("secret", "set", SECRET, "--repo", args.repo, input=key.read_bytes())
        configured = True
        dispatched = True
        terminal = False
        trial.gh(
            "workflow",
            "run",
            WORKFLOW,
            "--repo",
            args.repo,
            "--ref",
            args.ref,
            "-f",
            "collect=" + str(args.collect).lower(),
            "-f",
            "lower=" + args.lower,
            "-f",
            "upper=" + args.upper,
            "-f",
            "max_reports=" + str(args.max_reports),
        )
        deadline = time.monotonic() + 2400
        last = None
        while time.monotonic() < deadline:
            candidates = [
                r
                for r in runs(args.repo)
                if r["databaseId"] not in before
                and r["headSha"] == head
                and r["event"] == "workflow_dispatch"
            ]
            if len(candidates) > 1:
                raise RuntimeError("ambiguous dispatch")
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
            raise TimeoutError("bounded cloud workflow did not finish")
        run_id = str(selected["databaseId"])
        artifacts = json.loads(
            trial.gh("api", f"repos/{args.repo}/actions/runs/{run_id}/artifacts").stdout
        )["artifacts"]
        named = [a for a in artifacts if a["name"].startswith("senate-all-")]
        if not named:
            named = [a for a in artifacts if a["name"].startswith("senate-capture-")]
        if len(named) != 1:
            raise RuntimeError("one authenticated evidence artifact required")
        encrypted = output / "encrypted-artifact"
        encrypted.mkdir(mode=0o700)
        trial.gh(
            "run",
            "download",
            run_id,
            "--repo",
            args.repo,
            "--name",
            named[0]["name"],
            "--dir",
            str(encrypted),
        )
        files = list(encrypted.glob("*.enc"))
        if len(files) != 1:
            raise RuntimeError("one encrypted envelope required")
        archive = temporary / "evidence.zip"
        code = (
            "const fs=require('node:fs'),p=require(process.argv[2]);"
            "const k=Buffer.from(fs.readFileSync(process.argv[1],'utf8'),'base64');"
            "try{fs.writeFileSync(process.argv[4],p.decrypt(fs.readFileSync(process.argv[3]),k));}"
            "finally{k.fill(0)}"
        )
        subprocess.run(
            ["node", "-e", code, str(key), str(HERE / "protect.cjs"), str(files[0]), str(archive)],
            capture_output=True,
            check=True,
            timeout=60,
        )
        trial.unpack(
            archive,
            output / "private-evidence",
            max_bytes=512 * 1024**2,
            max_file=64 * 1024**2,
            max_files=5000,
        )
        retrieved = True
        record["authenticated_decryption_passed"] = True
        source = output / "private-evidence/source/capture/manifest.json"
        if args.collect and source.exists():
            m = json.loads(source.read_text())
            record["source_result"] = dict(
                complete=m.get("complete"),
                reason=m.get("reason"),
                reports=len(m.get("reports", [])),
                index_scans=len(m.get("index_scans", [])),
                assets=len(m.get("assets", [])),
                acknowledgements=m.get("acknowledgements"),
            )
        extraction = output / "private-evidence/extracted/manifest.json"
        if extraction.exists():
            m = json.loads(extraction.read_text())
            record["extraction_result"] = dict(
                reports=len(m["reports"]), review_required=m["review_required"], usage=m["usage"]
            )
        if (
            selected["conclusion"] != "success"
            or args.collect
            and not record.get("source_result", {}).get("complete")
        ):
            raise RuntimeError("collection incomplete; review evidence, do not retry a denial")
    except Exception as error:
        failure = error
        record["error_type"] = type(error).__name__
    finally:
        if dispatched and not terminal:
            try:
                pending = [
                    r
                    for r in runs(args.repo)
                    if r["databaseId"] not in before
                    and r["headSha"] == head
                    and r["event"] == "workflow_dispatch"
                ]
                if len(pending) != 1:
                    raise RuntimeError("dispatch terminal state unestablished")
                if pending[0]["status"] != "completed":
                    trial.gh("run", "cancel", str(pending[0]["databaseId"]), "--repo", args.repo)
                end = time.monotonic() + 90
                while time.monotonic() < end:
                    match = [
                        r for r in runs(args.repo) if r["databaseId"] == pending[0]["databaseId"]
                    ]
                    if match and match[0]["status"] == "completed":
                        terminal = True
                        break
                    time.sleep(5)
            except Exception:
                pass
        if configured and terminal:
            try:
                trial.gh("secret", "delete", SECRET, "--repo", args.repo)
                record["one_time_repository_secret_deleted"] = True
            except Exception:
                record["secret_cleanup_required"] = True
                failure = failure or RuntimeError("secret cleanup failed")
        if terminal and (retrieved or not dispatched):
            shutil.rmtree(temporary)
            record["ephemeral_local_key_directory_removed"] = True
        else:
            record.update(
                key_retained=True,
                recovery_key_directory=str(temporary),
                recovery_or_active_run_cleanup_required=True,
            )
        (output / "RESULT.json").write_text(json.dumps(record, indent=2) + "\n")
        (output / "RESULT.json").chmod(0o600)
    if failure:
        raise RuntimeError(
            "Collection incomplete; review RESULT.json and resolve cleanup before another attempt"
        ) from None
    print(json.dumps(record), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="treyhuffine/congressional-disclosures-senate-test")
    parser.add_argument("--ref", default="codex/windows-senate-trial")
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--lower", required=True)
    parser.add_argument("--upper", required=True)
    parser.add_argument("--max-reports", type=int, default=10)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--collect", action="store_true")
    main(parser.parse_args())
