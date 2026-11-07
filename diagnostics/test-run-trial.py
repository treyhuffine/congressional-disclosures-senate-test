"""Offline controller tests. No GitHub, Senate, or database requests."""

import base64
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("trial", HERE / "run-trial.py")
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class TrialTests(unittest.TestCase):
    def test_rejects_escaping_or_duplicate_archive_members(self):
        for names in (["../escape"], ["/escape"], ["a\\b"], ["C:escape"], ["same", "same"]):
            with self.subTest(names=names), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "fixture.zip"
                with zipfile.ZipFile(archive, "w") as z:
                    for name in names:
                        z.writestr(name, "FIXTURE_ONLY")
                with self.assertRaises(ValueError):
                    trial.unpack(archive, root / "output")
                self.assertFalse((root / "output").exists())

    def test_active_run_prevents_secret_and_dispatch(self):
        with (
            tempfile.TemporaryDirectory() as t,
            patch.object(trial, "runs", return_value=[dict(status="in_progress")]),
            patch.object(trial, "gh") as gh,
            patch.object(trial.shutil, "which", return_value="fixture"),
        ):
            with self.assertRaisesRegex(ValueError, "active"):
                trial.main("fixture/repo", Path(t) / "output", False)
            gh.assert_not_called()

    def test_fixture_dispatch_authentication_extraction_and_key_cleanup(self):
        state = dict(dispatched=False, key=None, deleted=False)
        selected = dict(
            databaseId=1,
            headSha=trial.QUALIFIED_SHA,
            event="workflow_dispatch",
            status="completed",
            conclusion="success",
            url="https://example.invalid/FIXTURE_ONLY",
        )

        def fake_gh(*args, **kwargs):
            args = list(args)
            if args[:2] == ["run", "list"]:
                result = [selected] if state["dispatched"] else []
            elif args[:2] == ["secret", "list"]:
                result = []
            elif args[0] == "api":
                result = dict(run_attempt=1) if "/actions/runs/" in args[1] else None
                if result is None:
                    return subprocess.CompletedProcess(
                        args, 0, (trial.QUALIFIED_SHA + "\n").encode(), b""
                    )
            elif args[:2] == ["secret", "set"]:
                state["key"] = kwargs["input"]
                self.assertEqual(len(base64.b64decode(state["key"])), 32)
                result = None
            elif args[:2] == ["workflow", "run"]:
                self.assertIn("collect=false", args)
                state["dispatched"] = True
                result = None
            elif args[:2] == ["run", "download"]:
                output = Path(args[args.index("--dir") + 1])
                data = io.BytesIO()
                with zipfile.ZipFile(data, "w") as z:
                    z.writestr("fixtures/fixture.json", '{"FIXTURE_ONLY":true}')
                program = (
                    "const p=require(process.argv[1]);let d=[];"
                    "process.stdin.on('data',b=>d.push(b));"
                    "process.stdin.on('end',()=>{const b=Buffer.concat(d);"
                    "process.stdout.write(p.encrypt(b.subarray(32),b.subarray(0,32)))})"
                )
                encrypted = subprocess.run(
                    ["node", "-e", program, str(HERE / "protect.cjs")],
                    input=base64.b64decode(state["key"]) + data.getvalue(),
                    capture_output=True,
                    check=True,
                ).stdout
                (output / "senate-evidence.enc").write_bytes(encrypted)
                result = None
            elif args[:2] == ["secret", "delete"]:
                state["deleted"] = True
                result = None
            else:
                raise AssertionError(args)
            return subprocess.CompletedProcess(args, 0, json.dumps(result).encode(), b"")

        with tempfile.TemporaryDirectory() as t, patch.object(trial, "gh", side_effect=fake_gh):
            output = Path(t) / "private-output"
            trial.main("fixture/repo", output, False)
            record = json.loads((output / "RESULT.json").read_text())
            self.assertTrue(record["authenticated_decryption_passed"])
            self.assertTrue(record["ephemeral_local_key_directory_removed"])
            self.assertTrue(record["one_time_repository_secret_deleted"])
            self.assertEqual(record["source_attempt_bound"], 0)
            self.assertEqual(
                json.loads((output / "private-evidence/fixtures/fixture.json").read_text()),
                dict(FIXTURE_ONLY=True),
            )
            self.assertTrue(state["deleted"])


if __name__ == "__main__":
    unittest.main()
