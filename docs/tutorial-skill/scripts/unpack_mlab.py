#!/usr/bin/env python3
"""Unpack a .mlab zip package into a MultiLab tutorial directory.

Usage:
  python unpack_mlab.py package.mlab -o output-dir

The unpacker performs safe path checks, extracts into a temporary directory,
validates the extracted tutorial, then moves it into place.
"""

import argparse
import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from pack_mlab import compute_package_digest
from validate_tutorial import validate


def safe_member_name(name):
    if not name or name.startswith('/') or '\\' in name:
        raise ValueError(f"unsafe zip member path: {name!r}")
    pure = PurePosixPath(name)
    if pure.is_absolute() or any(part in ('', '.', '..') for part in pure.parts):
        raise ValueError(f"unsafe zip member path: {name!r}")
    return pure.as_posix()


def checked_members(package):
    seen = set()
    members = []
    for info in package.infolist():
        if info.is_dir():
            continue
        name = safe_member_name(info.filename)
        if name in seen:
            raise ValueError(f"duplicate zip member path: {name}")
        seen.add(name)
        members.append((name, info))
    if 'multilab.json' not in seen:
        raise ValueError("missing multilab.json at package root")
    return members


def validate_or_exit(tutorial_dir):
    result = validate(tutorial_dir)
    if isinstance(result, tuple):
        errors, warnings = result
    else:
        errors, warnings = result, []

    if warnings:
        print("=== Warnings ===")
        for warning in warnings:
            print(f"  WARN: {warning}")
        print()

    if errors:
        print("=== Errors ===", file=sys.stderr)
        for error in errors:
            print(f"  FAIL: {error}", file=sys.stderr)
        print(f"\n{len(errors)} error(s) found.", file=sys.stderr)
        sys.exit(1)


def unpack_mlab(package_path, output_dir):
    package_path = package_path.resolve()
    output_dir = output_dir.resolve()
    if output_dir.exists():
        raise ValueError(f"output directory already exists: {output_dir}")

    with zipfile.ZipFile(package_path) as package:
        members = checked_members(package)
        with tempfile.TemporaryDirectory(prefix='multilab-unpack-') as tmp:
            tmp_dir = Path(tmp)
            for name, info in members:
                target = tmp_dir / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(package.read(info))

            validate_or_exit(tmp_dir)
            manifest = json.loads((tmp_dir / 'multilab.json').read_text(encoding='utf-8'))
            digest = compute_package_digest(tmp_dir)
            output_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(tmp_dir), str(output_dir))

    return {
        'output': str(output_dir),
        'digest': digest,
        'files': len(members),
        'id': manifest.get('id') or output_dir.name,
        'version': manifest.get('version') or '0.0.0',
    }


def main():
    parser = argparse.ArgumentParser(description='Unpack a .mlab package into a tutorial directory.')
    parser.add_argument('package', help='Path to a .mlab package')
    parser.add_argument('-o', '--output', required=True, help='Output tutorial directory')
    args = parser.parse_args()

    package_path = Path(args.package)
    if not package_path.is_file():
        print(f"not a file: {package_path}", file=sys.stderr)
        sys.exit(1)

    try:
        result = unpack_mlab(package_path, Path(args.output))
    except Exception as exc:
        print(f"unpack failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print("OK: package unpacked.")
    print(f"  output: {result['output']}")
    print(f"  id: {result['id']}")
    print(f"  version: {result['version']}")
    print(f"  digest: {result['digest']}")
    print(f"  files: {result['files']}")


if __name__ == '__main__':
    main()

