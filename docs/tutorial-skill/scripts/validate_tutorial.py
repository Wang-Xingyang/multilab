#!/usr/bin/env python3
"""MultiLab tutorial validator (file-based structure).

Checks a tutorial directory for common errors:
  - multilab.json syntax and required fields
  - step directory existence (steps/<id>/)
  - instructions.md present in each step
  - files/ directory present in each step
  - command script sanity
  - step id naming (semantic slug like 01-first-program, not bare numbers)
  - optional chain id naming
  - no emoji in instructions.md or source files
  - output binaries use /tmp/ in run.sh

Usage:
  python validate_tutorial.py <path-to-tutorial-dir>

Exit code 0 = valid, non-0 = errors found.
"""

import json
import re
import sys
from pathlib import Path

VALID_LANGUAGES = {'c', 'cpp', 'javascript', 'python', 'shell', 'rust', 'go'}
VALID_INHERIT_MODES = {'template', 'previous_save', 'overlay_template'}
VALID_COMMAND_TYPES = {'setup', 'run', 'test', 'check', 'preview', 'cleanup'}
PACKAGE_PANEL_TYPES = {
    'tutorial', 'file-tree', 'editor', 'terminal', 'test-results', 'web-preview',
}
HOST_PANEL_TYPES = {'logs', 'diagnostics'}
EMOJI_RE = re.compile(
    '[\U0001F300-\U0001F9FF\U0001FA00-\U0001FAFF\U00002600-\U000027BF]'
)
STEP_ID_RE = re.compile(r'^\d{2}-[a-z][a-z0-9-]*$')
CHAIN_ID_RE = re.compile(r'^[a-z][a-z0-9-]*$')
IMG_MD_RE = re.compile(r'!\[[^\]]*\]\(([^)]+)\)')
IMG_HTML_RE = re.compile(r'<img\b[^>]*\bsrc=["\']([^"\']+)["\']', re.I)
CONTENT_ASSET_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'}


def panel_type(entry):
    if isinstance(entry, str):
        return entry.strip()
    if isinstance(entry, dict):
        return str(entry.get('type') or '').strip()
    return ''


def declared_panel_types(entries):
    types = []
    if not isinstance(entries, list):
        return types
    for entry in entries:
        kind = panel_type(entry)
        if kind:
            types.append(kind)
    return types


def check_panel_list(entries, label, errors, warnings):
    if entries is None:
        return
    if not isinstance(entries, list):
        errors.append(f"{label}: panels must be an array of types or objects")
        return
    for entry in entries:
        if not isinstance(entry, (str, dict)):
            errors.append(f"{label}: panel entries must be strings or objects with type")
            continue
        kind = panel_type(entry)
        if not kind:
            warnings.append(f"{label}: panel entry is missing type")
            continue
        if kind in HOST_PANEL_TYPES:
            warnings.append(
                f"{label}: '{kind}' is host chrome, not a package window "
                "(omit it; diagnostics/logs open from the player)"
            )
            continue
        if kind not in PACKAGE_PANEL_TYPES:
            warnings.append(f"{label}: unknown panel type '{kind}' (dropped by the player)")


def looks_like_url(src):
    return bool(re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', src) or src.startswith('//'))


def check_instruction_assets(text, step_dir, tutorial_dir, step_id, warnings):
    srcs = IMG_MD_RE.findall(text) + IMG_HTML_RE.findall(text)
    for src in srcs:
        src = src.strip()
        if not src:
            continue
        if looks_like_url(src):
            if src.startswith(('http://', 'https://', '//')):
                warnings.append(
                    f"step '{step_id}': remote image '{src}' will not be loaded "
                    "(use a package-relative png/jpeg/gif/webp/bmp/svg)"
                )
            continue
        ext = Path(src.split('?', 1)[0]).suffix.lower()
        if ext and ext not in CONTENT_ASSET_EXTS:
            warnings.append(
                f"step '{step_id}': image '{src}' uses unsupported type {ext} "
                "(png/jpeg/gif/webp/bmp/svg)"
            )
        escaped = False
        found = False
        for base in (step_dir, tutorial_dir):
            candidate = (base / src).resolve()
            try:
                candidate.relative_to(tutorial_dir)
            except ValueError:
                warnings.append(f"step '{step_id}': image '{src}' escapes package directory")
                escaped = True
                break
            if candidate.is_file():
                found = True
                break
        if not escaped and not found:
            warnings.append(
                f"step '{step_id}': image '{src}' not found under step dir or package root"
            )


def check_no_emoji(text, label, errors):
    found = EMOJI_RE.findall(text)
    if found:
        errors.append(f"{label}: contains emoji/unicode symbols: {' '.join(set(found))}")


def resolve_package_path(tutorial_dir, rel_path, label, errors):
    if not rel_path or Path(rel_path).is_absolute():
        errors.append(f"{label}: script path must be package-relative")
        return None
    resolved = (tutorial_dir / rel_path).resolve()
    try:
        resolved.relative_to(tutorial_dir)
    except ValueError:
        errors.append(f"{label}: script path escapes tutorial directory")
        return None
    return resolved


def validate_script(script_path, label, language, errors, warnings, command_type=None):
    if not script_path or not script_path.exists():
        errors.append(f"{label}: script file does not exist")
        return

    script_text = script_path.read_text(encoding='utf-8')
    check_no_emoji(script_text, label, errors)
    if language in ('c', 'cpp') and ('gcc' in script_text or 'g++' in script_text):
        if command_type == 'run' and '/home/student/workspace/' not in script_text:
            warnings.append(f"{label}: compile command doesn't reference /home/student/workspace/, may use relative path")
        if '-o ' in script_text and '/tmp/' not in script_text:
            warnings.append(f"{label}: compile output may not go to /tmp/")


def validate(tutorial_dir):
    errors = []
    warnings = []
    tutorial_dir = Path(tutorial_dir).resolve()

    if not tutorial_dir.is_dir():
        return [f"not a directory: {tutorial_dir}"]

    # 1. multilab.json
    manifest_path = tutorial_dir / 'multilab.json'
    json_path = manifest_path
    manifest_name = json_path.name
    if not json_path.exists():
        errors.append("missing multilab.json")
        return errors

    try:
        cfg = json.loads(json_path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as e:
        errors.append(f"{manifest_name}: invalid JSON: {e}")
        return errors

    # required top-level fields
    required_fields = ('schema_version', 'id', 'version', 'title', 'description', 'language', 'steps')
    for field in required_fields:
        if field not in cfg:
            errors.append(f"{manifest_name}: missing required field '{field}'")

    if cfg.get('language') and cfg['language'] not in VALID_LANGUAGES:
        errors.append(f"{manifest_name}: invalid language '{cfg['language']}', must be one of {sorted(VALID_LANGUAGES)}")

    if 'runtime_requirements' not in cfg:
        warnings.append(f"{manifest_name}: missing runtime_requirements")

    check_panel_list(cfg.get('default_panels'), f"{manifest_name} default_panels", errors, warnings)
    package_panel_types = [
        kind for kind in declared_panel_types(cfg.get('default_panels'))
        if kind in PACKAGE_PANEL_TYPES
    ]

    # id should match directory name
    if cfg.get('id') and cfg['id'] != tutorial_dir.name:
        warnings.append(f"{manifest_name}: id '{cfg['id']}' does not match directory name '{tutorial_dir.name}'")

    steps = cfg.get('steps', [])
    if not steps:
        errors.append(f"{manifest_name}: steps array is empty")
        return errors

    # 2. each step
    steps_dir = tutorial_dir / 'steps'
    if not steps_dir.is_dir():
        errors.append("missing steps/ directory")
        return errors

    for i, step in enumerate(steps):
        step_id = step.get('id', f'<step {i}>')
        step_title = step.get('title', '')
        step_dir = steps_dir / step_id

        # step id naming
        if not STEP_ID_RE.match(str(step_id)):
            warnings.append(f"step '{step_id}': id should be semantic slug like '01-first-program', not bare number")

        # step directory exists
        if not step_dir.is_dir():
            errors.append(f"step '{step_id}': missing directory {step_dir.relative_to(tutorial_dir)}")
            continue

        # instructions.md
        instructions_path = step_dir / 'instructions.md'
        if not instructions_path.exists():
            errors.append(f"step '{step_id}': missing instructions.md")
        else:
            text = instructions_path.read_text(encoding='utf-8')
            check_no_emoji(text, f"step '{step_id}' instructions.md", errors)
            check_instruction_assets(text, step_dir, tutorial_dir, step_id, warnings)
            if len(text) > 3000:
                warnings.append(f"step '{step_id}': instructions.md is long ({len(text)} chars), consider splitting")

        # files/ directory
        files_dir = step_dir / 'files'
        if not files_dir.is_dir():
            errors.append(f"step '{step_id}': missing files/ directory")
        elif not any(files_dir.iterdir()):
            warnings.append(f"step '{step_id}': files/ directory is empty")

        # step title
        if not step_title:
            warnings.append(f"step '{step_id}': missing title")

        # chain id naming
        chain = step.get('chain')
        if chain is not None and not CHAIN_ID_RE.match(str(chain)):
            warnings.append(f"step '{step_id}': chain should be lowercase slug like 'mini-shell'")

        inherit_mode = step.get('inherit_mode')
        if inherit_mode not in VALID_INHERIT_MODES:
            errors.append(f"step '{step_id}': inherit_mode must be one of {sorted(VALID_INHERIT_MODES)}")

        check_panel_list(step.get('panels'), f"step '{step_id}' panels", errors, warnings)
        if step.get('panels'):
            effective_panels = [
                kind for kind in declared_panel_types(step.get('panels'))
                if kind in PACKAGE_PANEL_TYPES
            ]
        else:
            effective_panels = package_panel_types

        commands = step.get('commands', [])
        if not isinstance(commands, list) or not commands:
            warnings.append(f"step '{step_id}': no commands declared")
        if not isinstance(commands, list):
            commands = []
        command_types = set()
        for j, command in enumerate(commands):
            label = f"step '{step_id}' command {j}"
            command_type = command.get('type')
            command_types.add(command_type)
            if command_type not in VALID_COMMAND_TYPES:
                errors.append(f"{label}: type must be one of {sorted(VALID_COMMAND_TYPES)}")
            script = command.get('script')
            script_path = resolve_package_path(tutorial_dir, script, label, errors)
            validate_script(script_path, label, cfg.get('language'), errors, warnings, command_type)

        if 'preview' in command_types and 'web-preview' not in effective_panels and effective_panels:
            warnings.append(
                f"step '{step_id}': has a preview command but this step's windows "
                "do not include web-preview"
            )
        if any(c.get('terminal') == 'interactive' for c in commands if isinstance(c, dict)) \
                and 'terminal' not in effective_panels and effective_panels:
            warnings.append(
                f"step '{step_id}': has an interactive command but this step's windows "
                "do not include terminal"
            )

        # check for old-style inline fields (migration check)
        for old_field in ('instructions', 'files', 'run_cmd'):
            if old_field in step:
                errors.append(f"step '{step_id}': found inline '{old_field}' in {manifest_name} — content should be in real files under steps/{step_id}/")

    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print("Usage: python validate_tutorial.py <path-to-tutorial-dir>")
        sys.exit(2)

    result = validate(sys.argv[1])
    if isinstance(result, tuple):
        errors, warnings = result
    else:
        errors, warnings = result, []

    if warnings:
        print("=== Warnings ===")
        for w in warnings:
            print(f"  WARN: {w}")
        print()

    if errors:
        print("=== Errors ===")
        for e in errors:
            print(f"  FAIL: {e}")
        print(f"\n{len(errors)} error(s) found.")
        sys.exit(1)

    print("OK: tutorial structure is valid.")
    if warnings:
        print(f"({len(warnings)} warning(s))")
    sys.exit(0)


if __name__ == '__main__':
    main()
