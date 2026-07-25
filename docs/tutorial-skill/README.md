# Tutorial Skill

This folder contains the local authoring guidance used to generate MultiLab tutorials.

Current format:

```text
multilab.json
steps/<id>/instructions.md
steps/<id>/files/
steps/<id>/commands/
```

Do not generate or document `tutorial.json`.

## Files

```text
tutorial-skill/
  SKILL.md
  references/
    tutorial-format.md
  assets/
    tutorial-template/
  scripts/
    validate_tutorial.py
```

## Validate A Tutorial

```bash
cd multilab
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
```

## Use The Template

```bash
cp -r docs/tutorial-skill/assets/tutorial-template ../tutorials/my-tutorial
```

Then edit:

- `multilab.json`
- `steps/01-example/instructions.md`
- `steps/01-example/files/main.c`
- `steps/01-example/commands/run.sh`
- `steps/01-example/commands/test.sh`
