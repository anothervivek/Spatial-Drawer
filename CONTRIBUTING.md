# Contributing

Thanks for improving Spatial Drawer.

## Development Setup

Install Lens Studio and Blender 4.0+. See [docs/development.md](docs/development.md) for the full prerequisite list and check commands.

## Checks

Before sharing changes:

```bash
python3 -m py_compile blender_plugin/spectacles_bridge.py
```

Open the Lens in Lens Studio and confirm the Logger panel shows no script errors on load.

## Scope

Keep the prototype small and symmetric:

- every new broadcast action needs a matching handler on both the Lens and Blender sides
- every new radial menu button needs a documented input in `SpatialDrawer.js` and an entry in [docs/lens-setup.md](docs/lens-setup.md)
- prefer extending an existing brush's state pattern over introducing a new state-management approach

## Documentation

Update docs when changing setup, protocol fields, radial menu buttons, brush behavior, or Blender panel fields. The main entry points are:

```txt
README.md
docs/lens-setup.md
docs/blender-setup.md
docs/protocol.md
docs/architecture.md
docs/testing-checklist.md
CHANGELOG.md
```

Add a new `CHANGELOG.md` entry for any user-visible change, following the existing `[Phase N]` format.
