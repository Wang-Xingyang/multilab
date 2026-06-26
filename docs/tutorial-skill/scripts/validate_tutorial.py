#!/usr/bin/env python3
"""MultiLab tutorial JSON validator.

Checks a tutorial.json file for common errors:
  - JSON syntax
  - Required fields present
  - language enum valid
  - run_cmd file paths match files[].name
  - No emoji in instructions/content
  - Output binaries use /tmp/
  - Common JSON escaping mistakes

Usage:
  python validate_tutorial.py <path-to-tutorial.json>
"""

import json
import re
import sys
from pathlib import Path

VALID_LANGUAGES = {"c", "cpp", "javascript", "python", "shell", "rust", "go"}

# Emoji and unicode symbol ranges to flag
EMOJI_PATTERN = re.compile(
    "["
    "\U0001F000-\U0001FAFF"  # symbols & pictographs
    "\U00002600-\U000027BF"  # misc symbols & dingbats
    "\U00002B00-\U00002BFF"  # misc symbols & arrows
    "\U00002190-\U000021FF"  # arrows
    "\U00002700-\U000027BF"  # dingbats
    "\U0000FE00-\U0000FE0F"  # variation selectors
    "\U0001F1E0-\U0001F1FF"  # flags
    "]",
    flags=re.UNICODE,
)


def fail(msg, errors):
    print(f"  FAIL: {msg}")
    errors.append(msg)


def warn(msg, warnings):
    print(f"  WARN: {msg}")
    warnings.append(msg)


def check_required(obj, required, path, errors):
    """Check that all required keys exist in obj."""
    ok = True
    for key in required:
        if key not in obj:
            print(f"  FAIL: {path}.{key} is required but missing")
            errors.append(f"{path}.{key} missing")
            ok = False
    return ok


def validate_tutorial(data, filepath):
    errors = []
    warnings = []

    print(f"\nValidating: {filepath}")
    print("-" * 60)

    # Top-level required fields
    if not check_required(data, ["id", "title", "description", "language", "steps"], "$", errors):
        return errors, warnings

    # id matches directory name
    tutorial_dir = Path(filepath).parent.name
    if data.get("id") != tutorial_dir:
        warn(f"$.id ({data.get('id')}) does not match directory name ({tutorial_dir})", warnings)

    # language is valid
    lang = data.get("language")
    if lang not in VALID_LANGUAGES:
        fail(f"$.language '{lang}' is not valid. Must be one of: {sorted(VALID_LANGUAGES)}", errors)

    # steps is non-empty array
    steps = data.get("steps", [])
    if not isinstance(steps, list) or len(steps) == 0:
        fail("$.steps must be a non-empty array", errors)
        return errors, warnings

    print(f"  OK: {len(steps)} step(s) found")

    # Validate each step
    for i, step in enumerate(steps):
        step_path = f"$.steps[{i}]"
        print(f"\n  Step {i}: {step.get('title', '(no title)')}")

        if not check_required(step, ["title", "instructions"], step_path, errors):
            continue

        # files (optional but recommended)
        files = step.get("files", [])
        if not files:
            warn(f"{step_path}.files is empty - editor will start with no code", warnings)

        # Check file objects
        file_names = []
        for j, f in enumerate(files):
            file_path = f"{step_path}.files[{j}]"
            if not check_required(f, ["name", "content"], file_path, errors):
                continue
            file_names.append(f["name"])

            # Check emoji in content
            matches = EMOJI_PATTERN.findall(f.get("content", ""))
            if matches:
                warn(f"{file_path}.content contains emoji/symbols: {''.join(matches)}", warnings)

        # Check run_cmd references
        run_cmd = step.get("run_cmd", "")
        if run_cmd:
            # Extract referenced workspace files
            referenced = set(re.findall(r"/home/student/workspace/(\S+)", run_cmd))
            for ref in referenced:
                # Strip wildcards
                clean_ref = ref.replace("*", "").rstrip("/")
                if clean_ref and clean_ref not in file_names and "*" not in ref:
                    # Check if it's a partial match (e.g., *.c)
                    if not any(fn.endswith(clean_ref) or clean_ref.endswith(fn) for fn in file_names):
                        warn(
                            f"{step_path}.run_cmd references '{ref}' "
                            f"but files are: {file_names}",
                            warnings,
                        )

            # Check output binary location
            if "-o " in run_cmd:
                output_match = re.search(r"-o\s+(\S+)", run_cmd)
                if output_match:
                    output_path = output_match.group(1)
                    if not output_path.startswith("/tmp/"):
                        warn(
                            f"{step_path}.run_cmd outputs to '{output_path}' - "
                            f"prefer /tmp/ to avoid polluting workspace",
                            warnings,
                        )

        # Check emoji in instructions
        matches = EMOJI_PATTERN.findall(step.get("instructions", ""))
        if matches:
            warn(f"{step_path}.instructions contains emoji/symbols: {''.join(matches)}", warnings)

        # Check instructions length (rough word count)
        instructions = step.get("instructions", "")
        word_count = len(instructions.split())
        if word_count > 400:
            warn(f"{step_path}.instructions is {word_count} words - consider splitting into more steps", warnings)

        # Check for TODO in code
        has_todo = any("TODO" in f.get("content", "") for f in files)
        if not has_todo and files:
            warn(f"{step_path}: no TODO markers found in code - consider adding interactive prompts", warnings)

    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print("Usage: python validate_tutorial.py <path-to-tutorial.json>")
        sys.exit(2)

    filepath = sys.argv[1]
    if not Path(filepath).exists():
        print(f"Error: file not found: {filepath}")
        sys.exit(2)

    # Parse JSON
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"\nJSON SYNTAX ERROR:")
        print(f"  {e}")
        print(f"\nCommon fixes:")
        print(f"  - Unescaped quotes: use \\\" inside strings")
        print(f"  - Unescaped backslash: use \\\\ for literal backslash")
        print(f"  - Unescaped newline: use \\n inside strings")
        print(f"  - Trailing comma: remove comma before closing }} or ]")
        sys.exit(1)

    errors, warnings = validate_tutorial(data, filepath)

    print("\n" + "=" * 60)
    if errors:
        print(f"RESULT: {len(errors)} error(s), {len(warnings)} warning(s)")
        print("\nFix the errors above before delivering the tutorial.")
        sys.exit(1)
    elif warnings:
        print(f"RESULT: 0 errors, {len(warnings)} warning(s)")
        print("\nTutorial is valid. Review the warnings above (optional fixes).")
        sys.exit(0)
    else:
        print("RESULT: 0 errors, 0 warnings")
        print("\nTutorial is valid and ready to use.")
        sys.exit(0)


if __name__ == "__main__":
    main()
