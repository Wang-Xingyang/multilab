#!/usr/bin/env python3
"""Pack a MultiLab tutorial directory into a .mlab zip package.

Usage:
  python pack_mlab.py <path-to-tutorial-dir> [-o output.mlab]

The packer validates the tutorial first, then writes a deterministic zip whose
root contains multilab.json and the tutorial's package files.
"""

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

from validate_tutorial import validate


FIXED_ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def package_files(tutorial_dir):
    files = []
    for path in tutorial_dir.rglob('*'):
        if path.is_file():
            files.append(path.relative_to(tutorial_dir).as_posix())
    return sorted(files)


def compute_package_digest(tutorial_dir):
    digest = hashlib.sha256()
    for rel_path in package_files(tutorial_dir):
        content = (tutorial_dir / rel_path).read_bytes()
        digest.update(b'file\0')
        digest.update(rel_path.encode('utf-8'))
        digest.update(b'\0')
        digest.update(str(len(content)).encode('utf-8'))
        digest.update(b'\0')
        digest.update(content)
        digest.update(b'\0')
    return f"sha256:{digest.hexdigest()}"


def default_output_path(tutorial_dir, manifest):
    package_id = manifest.get('id') or tutorial_dir.name
    version = manifest.get('version') or '0.0.0'
    return tutorial_dir.parent / f"{package_id}-{version}.mlab"


def ensure_output_not_inside_source(tutorial_dir, output_path):
    try:
        output_path.resolve().relative_to(tutorial_dir.resolve())
    except ValueError:
        return
    raise ValueError("output .mlab path must not be inside the tutorial directory")


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


def pack_mlab(tutorial_dir, output_path):
    tutorial_dir = tutorial_dir.resolve()
    manifest_path = tutorial_dir / 'multilab.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    output_path = output_path.resolve()
    ensure_output_not_inside_source(tutorial_dir, output_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    digest = compute_package_digest(tutorial_dir)

    with zipfile.ZipFile(output_path, 'w', compression=zipfile.ZIP_DEFLATED) as package:
        for rel_path in package_files(tutorial_dir):
            source_path = tutorial_dir / rel_path
            info = zipfile.ZipInfo(rel_path, date_time=FIXED_ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            package.writestr(info, source_path.read_bytes())

    return {
        'output': str(output_path),
        'digest': digest,
        'files': len(package_files(tutorial_dir)),
        'id': manifest.get('id') or tutorial_dir.name,
        'version': manifest.get('version') or '0.0.0',
    }


def main():
    parser = argparse.ArgumentParser(description='Pack a MultiLab tutorial directory into a .mlab package.')
    parser.add_argument('tutorial_dir', help='Path to a tutorial directory containing multilab.json')
    parser.add_argument('-o', '--output', help='Output .mlab path')
    args = parser.parse_args()

    tutorial_dir = Path(args.tutorial_dir)
    if not tutorial_dir.is_dir():
        print(f"not a directory: {tutorial_dir}", file=sys.stderr)
        sys.exit(1)

    validate_or_exit(tutorial_dir)
    manifest = json.loads((tutorial_dir / 'multilab.json').read_text(encoding='utf-8'))
    output_path = Path(args.output) if args.output else default_output_path(tutorial_dir, manifest)

    try:
        result = pack_mlab(tutorial_dir, output_path)
    except Exception as exc:
        print(f"pack failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print("OK: package written.")
    print(f"  output: {result['output']}")
    print(f"  id: {result['id']}")
    print(f"  version: {result['version']}")
    print(f"  digest: {result['digest']}")
    print(f"  files: {result['files']}")


if __name__ == '__main__':
    main()

