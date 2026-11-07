"""Bounded private evidence archive; no credentials or profile directory is included."""

import argparse
import importlib.util
import zipfile
from pathlib import Path


def unpack(source, output):
    spec = importlib.util.spec_from_file_location(
        "caller", Path(__file__).with_name("run-trial.py")
    )
    caller = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(caller)
    caller.unpack(source, output, max_bytes=512 * 1024**2, max_file=64 * 1024**2, max_files=5000)


def pack(source, output):
    files = [f for f in source.rglob("*") if f.is_file() or f.is_symlink()]
    if (
        len(files) > 5000
        or any(f.is_symlink() or f.stat().st_size > 64 * 1024**2 for f in files)
        or sum(f.stat().st_size for f in files) > 512 * 1024**2
    ):
        raise ValueError("evidence archive exceeds bounds or contains links")
    with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            archive.write(file, file.relative_to(source))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["pack", "unpack"])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    (pack if args.mode == "pack" else unpack)(args.source, args.output)
