# Open `.npy` Files with Voxel Mesh Viewer

Voxel Mesh Viewer can open a three-dimensional NumPy array directly from Finder,
the Windows **Open with** menu, or a command line. Opening a file starts the app
when needed and loads it into the field inspector. If a supported metadata file
is beside the array, the app loads that metadata with it.

## macOS: install and make it the default

From the project directory, build and install the app:

```bash
npm run mac:app
```

The installed copy is written to:

```text
~/Applications/Voxel Mesh Viewer.app
```

Register that copy as the default application for `.npy` files:

```bash
npm run mac:register-npy
```

The registration command first registers the app bundle with macOS, sets its
NumPy document type as the default, and verifies that macOS retained the setting.
After it succeeds, double-click any `.npy` file in Finder. You can also test it
from Terminal:

```bash
open /path/to/field.npy
```

To select the default application through Finder instead, choose an `.npy` file,
open **File > Get Info**, select **Voxel Mesh Viewer** under **Open with**, and
click **Change All**.

Re-run `npm run mac:register-npy` if the installed app is moved, replaced under a
different bundle identifier, or macOS changes the association.

## Windows: make the portable build the default

Extract the complete Windows ZIP before setting the association. Then:

1. Right-click an `.npy` file and select **Open with > Choose another app**.
2. Enable **Always use this app to open .npy files**.
3. Select **Look for another app on this PC** and choose
   `Voxel Mesh Viewer.exe` from the extracted folder.

Keep the extracted folder in that location after registration. The portable app
accepts both `.npy` and `.vxz` paths when Windows starts it or forwards a file to
an already-running instance.

## Metadata loaded with a double-clicked array

When `field.npy` is opened directly, the viewer checks the same directory for
these optional metadata filenames:

- `fields.json`
- `field_metadata.json`
- `npy_fields.json`
- `npy_labels.json`

The metadata and selected array are treated as one input folder. For example:

```text
experiment-12/
  fields.json
  component_id.npy
```

Double-clicking `component_id.npy` applies its entry from `fields.json`. Other
arrays in the directory are not loaded automatically; use **Open field** or
**Open folder** when you want to compare several fields together.

Without metadata, the viewer infers a suggested semantic from the dtype and uses
index coordinates. You can change categorical/continuous semantics, axis order,
point/cell association, and coordinates in the field controls. See the
[expected NumPy input reference](../README.md#expected-npy-input) for the
complete metadata format.

## Input requirements

- The file must be a valid, non-empty, three-dimensional `.npy` array.
- Labels remain discrete; integer IDs, including 64-bit IDs, are preserved.
- Large arrays are currently read into memory for exact inspection. The app
  reports loading progress and shows any parse or shape error in its status bar.
