# Tutorial Skill

This folder contains the local authoring guidance used to generate MultiLab tutorials.

Current format:

```text
multilab.json
assets/                 # optional diagrams (png/jpeg/gif/webp/bmp/svg)
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
    pack_mlab.py
    unpack_mlab.py
```

## Validate A Tutorial

```bash
cd multilab
python3 docs/tutorial-skill/scripts/validate_tutorial.py ../tutorials/hello-c
```

## Pack A Tutorial

```bash
cd multilab
python3 docs/tutorial-skill/scripts/pack_mlab.py ../tutorials/hello-c -o /tmp/hello-c.mlab
```

The packer validates the tutorial first, then writes a `.mlab` ZIP package with `multilab.json` at the root and prints the package digest.

## Unpack A Tutorial

```bash
cd multilab
python3 docs/tutorial-skill/scripts/unpack_mlab.py /tmp/hello-c.mlab -o /tmp/hello-c-unpacked
```

The unpacker safely extracts package files into a new directory and validates the extracted tutorial before moving it into place.

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
- optional `assets/*.svg` (or png/jpeg/gif/webp/bmp) referenced from Markdown as `![alt](assets/flow.svg)`
