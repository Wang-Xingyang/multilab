# MultiLab Tutorial Generator Skill

This is a WorkBuddy skill for generating MultiLab tutorial JSON files. It can be used by any WorkBuddy agent to create new tutorials following the correct format and best practices.

## Installation

To install this skill into your WorkBuddy (so it auto-triggers when you ask to write tutorials):

```bash
# Copy to user-level skills directory (available across all projects)
cp -r docs/tutorial-skill ~/.workbuddy/skills/multilab-tutorial-generator
```

After installation, any WorkBuddy session will automatically trigger this skill when you ask things like:
- "帮我写一个 C 指针教程"
- "生成一个 Python 列表教程"
- "给 MultiLab 写个 gdb 调试教程"

## Usage Without Installation

If you don't want to install it as a skill, you can still use the components directly:

### Validate a tutorial

```bash
python docs/tutorial-skill/scripts/validate_tutorial.py tutorials/my-tutorial/tutorial.json
```

### Use the template

Copy `assets/tutorial-template.json` as a starting point:

```bash
mkdir -p tutorials/my-new-tutorial
cp docs/tutorial-skill/assets/tutorial-template.json tutorials/my-new-tutorial/tutorial.json
# Edit the JSON with your tutorial content
```

### Reference the format spec

See `references/tutorial-format.md` for the complete field reference.

## Contents

```
tutorial-skill/
├── SKILL.md                          # Main skill instructions (loaded by WorkBuddy)
├── README.md                         # This file
├── references/
│   └── tutorial-format.md            # Complete JSON schema reference
├── assets/
│   └── tutorial-template.json        # Copy-paste starting template (3-step)
└── scripts/
    └── validate_tutorial.py          # Validation script
```

## For AI Agents

If you are an AI agent asked to write a MultiLab tutorial:

1. Read `SKILL.md` for the full workflow and rules
2. Read `references/tutorial-format.md` for field details
3. Start from `assets/tutorial-template.json`
4. Write the tutorial to `tutorials/<id>/tutorial.json`
5. Run `python docs/tutorial-skill/scripts/validate_tutorial.py tutorials/<id>/tutorial.json`
6. Fix any errors, then deliver

The 10 mandatory authoring rules are in `SKILL.md` under "Authoring Rules (Mandatory)".
