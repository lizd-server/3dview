# Interactive Mesh Slice Viewer

Client-side Three.js viewer for inspecting three-dimensional NumPy fields and
pipeline label slices against mesh geometry.

## Run

```bash
npm install
npm run dev
```

The dev command starts:

- frontend: `http://127.0.0.1:5173/`
- local remote-file backend: `http://127.0.0.1:5175/`

For a production build:

```bash
npm run build
```

## Decode O-Voxel VXZ on macOS

`decode_vxz.py` is a CPU/NumPy reproduction of the decoder in
`lizhuodong/ovoxel_produce`. It follows the signed Flexible Dual Grid format
from `gameAI-cvcg/trellis`, but does not compile or call its CUDA extension, so
it runs locally on Apple Silicon.

Create a small isolated environment once:

```bash
uv venv --python 3.11 .venv-vxz
uv pip install --python .venv-vxz/bin/python -r requirements-vxz.txt
```

Decode one `.vxz`, a recursively searched folder, or a text file containing
one VXZ path per line:

```bash
.venv-vxz/bin/python decode_vxz.py input.vxz decoded
.venv-vxz/bin/python decode_vxz.py /path/to/folder decoded --resolution auto
.venv-vxz/bin/python decode_vxz.py vxz_files.txt decoded --resolution 1536
```

The output is binary little-endian PLY. Directory input preserves the relative
folder structure, so repeated names such as `*/ovoxel.vxz` do not overwrite
each other. Resolution defaults to automatic inference; pass it explicitly for
VXZ data whose occupied coordinates do not reach the grid boundary.

See [VXZ_VISUALIZATION.md](VXZ_VISUALIZATION.md) for the binary contracts,
coordinate mapping, and exact slice acceptance criteria.

## Open O-Voxel VXZ in the viewer

After creating `.venv-vxz`, start the normal viewer and click **Open VXZ**:

```bash
npm run dev
```

VXZ itself does not store the parent grid resolution. Leave **VXZ resolution**
in Options on Auto when occupied coordinates reach the grid boundary (as both
supplied `r=1536` samples do). Otherwise enter the source resolution before
opening the file; the explicit value is part of the cache key and is used by
mesh, voxel, slice, and world-coordinate paths together.

The integrated VXZ path loads three coordinated views from the same source
coordinates:

- a voxel overview capped at about 750,000 cell-centered points;
- a decoded dual-grid mesh rendered through the same solid/wireframe/transparent
  material and slice-clipping pipeline as imported PLY/OBJ/STL meshes; its viewport
  LOD targets about 5,000,000 triangles;
- an exact on-demand `R x R` X/Y/Z slice queried from every sparse VXZ record.

When **Normalize imports to current size** is enabled while a VXZ is open,
new PLY/OBJ/STL meshes are uniformly scaled and centered to that VXZ's exact
decoded bounds. Previously imported comparison meshes do not enlarge the
normalization reference. Without a VXZ, the existing mesh bounds are used.

The Options panel can independently hide the mesh, voxels, or projected dual
vertices, change point size, and color voxels by occupancy, signed intersections,
dual offset, the optional `ovoxel_type` fallback case, or the optional `qef_rank`.
Dual vertices are shown
both on the native-resolution 2D slice and on its matching 3D slice plane.
Fallback colors distinguish the 3D
interior solution (0), 2D face solution (1), 1D edge solution (2), and corner
solution (3); the option is disabled for older VXZ files without that field.
QEF rank colors distinguish deficient ranks 0/1/2 from full rank 3. The stored
rank is defined by the producer before adding the QEF regularization term, with
a relative threshold of `1e-5`; the viewer consumes that value directly and does
not recompute rank from the regularized system. This option is likewise disabled
for older VXZ files without `qef_rank`.
The exact decoded mesh remains available through `decode_vxz.py`. The interactive
viewer uses a vertex-clustered, connected viewport LOD from that decoded topology
so the supplied 42.9-million-triangle sample does not allocate the full mesh in
browser memory. This LOD is a regular mesh object (not a point or placeholder
preview), and it can be shown together with the exact grid-aligned voxel slice.
Decoded VXZ meshes use flat face shading by default so voxel-scale steps and hard
edges remain as legible as they are in MeshLab.

VXZ slices are cell-centered. For resolution `R`, slice index `k` is placed at
`-0.5 + (k + 0.5) / R`. The right pane is a native `R x R` scrollable canvas
with nearest-neighbor rendering and no mipmaps: one CSS/image pixel is exactly
one O-Voxel grid cell. Pointer inspection reports that pixel's exact integer
grid coordinate, world-space cell center, dual vertex, signed-edge bits, and
fallback case and QEF rank/deficiency when available.

Decoded previews and exact sparse attributes are cached by VXZ SHA-256 in the
viewer cache directory. The standalone backend defaults to
`~/Library/Caches/voxel-mesh-viewer/vxz`; the desktop app uses its system app
cache. Opening the same file again avoids rebuilding topology. Preparations are
serialized through one worker because a full-resolution VXZ can use substantial
memory; slice requests remain on-demand and replace older requests for the same
file.

## macOS App

Create and install the standalone Electron macOS app:

```bash
npm run mac:app
```

This writes `dist-mac/Voxel Mesh Viewer-darwin-<arch>/Voxel Mesh Viewer.app` and installs a copy to `~/Applications/Voxel Mesh Viewer.app`. The app bundles a relocatable Python 3.11 + NumPy VXZ runtime, so the installed copy does not depend on the source checkout or `.venv-vxz` after packaging.

Register the installed app as the macOS default for `.vxz` files with:

```bash
npm run mac:register-vxz
```

Register it as the default for `.npy` files with:

```bash
npm run mac:register-npy
```

Double-clicked `.npy` files open in the generic field inspector. A supported
metadata JSON file in the same directory is loaded automatically. See the
[`.npy` default-app guide](docs/NPY_FILE_ASSOCIATION.md) for macOS and Windows
setup, verification, metadata behavior, and troubleshooting.

After registration, double-clicking a `.vxz` file launches the viewer and automatically loads that file. Finder opens use the explicit **VXZ resolution** saved in Options; when that field is blank they use Auto, like the in-app file picker. The app stores this preference under its stable macOS Application Support directory, so it survives the app's random internal port changing between launches.

Double-clicking the app opens a native macOS application window, not an external browser. The packaged app serves the built frontend and the read-only remote-file API inside the Electron main process on an app-owned loopback port, so PM2, Vite, and fixed ports such as `5173`/`5175` are not required for normal app use.

## Windows App

Create a portable Windows 10/11 x64 build with:

```bash
npm run win:app
```

The command writes both an unpacked application and a ZIP archive:

- `dist-win/Voxel Mesh Viewer-win32-x64/Voxel Mesh Viewer.exe`
- `dist-win/Voxel-Mesh-Viewer-windows-x64.zip`

The first build downloads pinned official Windows x64 packages for embedded
Python and NumPy into `.windows-runtime-cache`; later builds reuse the verified
downloads. The portable app includes the generic field/mesh views and the VXZ
decoder. Extract the entire ZIP before launching `Voxel Mesh Viewer.exe`.

Opening a `.vxz` or `.npy` through **Open with** or as a command-line argument is
supported. The portable ZIP does not register a Windows file association; the
[`.npy` default-app guide](docs/NPY_FILE_ASSOCIATION.md#windows-make-the-portable-build-the-default)
shows how to select the extracted executable once and make it the default.
Remote browsing uses `ssh.exe` from the Windows OpenSSH Client; set
`REMOTE_VIEWER_SSH_BIN` when the executable is installed outside `PATH`.
This build is not Authenticode-signed, so Windows SmartScreen may ask for
confirmation on its first launch.

## Expected `.npy` input

Use the Folder input to open a dataset directory. Every supported
three-dimensional `.npy` file appears as a field, and filenames may be
arbitrary. A field must have exactly three non-empty dimensions; non-cubic
shapes are supported.

Supported arrays:

- NumPy format versions 1, 2, and 3
- `bool`
- `int8`, `int16`, `int32`, and `int64`
- `uint8`, `uint16`, `uint32`, and `uint64`
- `float16`, `float32`, and `float64`
- Little-endian or big-endian data
- C-order or Fortran-order storage

The viewer rejects `.npz` archives, rank-2 images, rank-4 batch or channel
arrays, and object, string, structured, complex, or pickled arrays.

A typical dataset looks like this:

```text
run-0042/
  fields.json
  labels.npy
  sdf.npy
  input_mesh.ply
```

For the common NumPy layout below, source dimensions are ordered Z, Y, X:

```python
labels = np.zeros((nz, ny, nx), dtype=np.uint16)
sdf = np.zeros((nz, ny, nx), dtype=np.float32)

np.save("labels.npy", labels, allow_pickle=False)
np.save("sdf.npy", sdf, allow_pickle=False)
```

Set `"axisOrder": "zyx"` in `fields.json` for these arrays. The viewer then
exposes source shape `[nz, ny, nx]` as logical XYZ shape `[nx, ny, nz]`.

### Categorical and continuous fields

The dtype suggests a default, but does not determine what a field means:

| Semantic | Use for | Recommended dtype |
| --- | --- | --- |
| `categorical` | Labels, masks, component IDs, part IDs, algorithm cases | Integer or boolean |
| `continuous` | SDF, distance, confidence, probability, error | Floating point |

Categorical values are identities. Label `103` is not greater or stronger than
label `7`, and the viewer does not interpolate between label IDs. Continuous
values are magnitudes and can use ranges, color scales, contours, and
isovalues. Declare `semantic` explicitly whenever possible. Signed and
unsigned 64-bit categorical IDs remain exact, including values above
JavaScript's safe integer range.

### Minimal `fields.json`

Place `fields.json` beside the arrays. `defaults` applies to every field, while
an entry under `fields` overrides those defaults for one exact filename:

```json
{
  "version": 1,
  "defaults": {
    "axisOrder": "zyx",
    "association": "cell",
    "coordinatePreset": "index"
  },
  "fields": {
    "labels.npy": {
      "semantic": "categorical",
      "categoricalPreset": "semantic",
      "labels": {
        "0": {
          "name": "background",
          "color": "#1f2933",
          "background": true,
          "hidden": true
        },
        "1": {
          "name": "object",
          "color": "#2563eb"
        }
      }
    },
    "sdf.npy": {
      "semantic": "continuous",
      "continuousStyle": {
        "range": null
      }
    }
  }
}
```

The main metadata keys are:

- `axisOrder`: logical axis represented by each NumPy dimension. Use `"zyx"`
  for `[Z, Y, X]` and `"xyz"` for `[X, Y, Z]`.
- `association`: `"point"` for grid-node samples or `"cell"` for cell-center
  samples.
- `coordinatePreset`: `"index"` for index-space coordinates or `"normalized"`
  when the complete grid domain really spans `[-1, 1]`.
- `indexToWorld`: optional row-major affine 4 x 4 matrix applied to logical
  `[x, y, z, 1]`. Use it for physical, translated, rotated, or anisotropic
  grids. It takes precedence over `coordinatePreset`.
- `labels`: names, colors, groups, and initial visibility keyed by the exact
  categorical value. No ID, including `0`, is assumed to be background.
- `validity.noDataValues`: exact values that mean missing or invalid data.
- `sparseDefault`: value used for absent samples in the original sparse data.
- `continuousStyle.range`: two increasing values, or `null` to calculate the
  display range from valid samples.

Quote integer IDs in JSON when they may exceed `9007199254740991`, for example
`"9007199254740993"`.

Without `fields.json`, the viewer uses `axisOrder: "xyz"`, point association,
and index coordinates. Integer and boolean dtypes are suggested as categorical;
floating-point dtypes are suggested as continuous. Metadata and the in-app
controls can override these defaults.

The selected dense field is loaded in full. A `1024 x 1024 x 1024` `uint32`
array is 4 GiB before parsing, caching, and GPU use.

See the [Data Producer Guide](docs/DATA_PRODUCER_GUIDE.md) for the complete
metadata schema, coordinate conventions, mesh alignment rules, no-data values,
atomic output pattern, and a copyable Python exporter.

### Legacy pipeline presets

Known floodfill filenames still select the existing point-sampled normalized
coordinates, field semantics, label meanings, and colors automatically.
`fields.json` can override those presets, and the legacy `npy_labels.json`
manifest remains supported. Incomplete debug folders can still be inspected.
A complete final CCL stage includes:

- `NNN_final_ccl_labels.npy`
- `NNN_final_ccl_components.npy`
- `NNN_final_ccl_cases.npy`

The viewer also loads earlier/later-stage and newer debug volumes when they are present:

- `000_original_boundary.npy`
- `001_closed_boundary.npy`
- `002_free_space_labels.npy`
- `003_pseudo_boundary_components.npy`
- `004_final_labels.npy`
- `000_initial_ccl_labels.npy`
- `MMM_inside_filtered_labels.npy`, with `MMM = NNN + 1`
- `SSS_surface_boundary_classification.npy`, with `SSS = NNN + 2`
- `999_scalar_field.npy`
- `999_linf_distance_cases.npy`, when the upstream run uses the L-infinity distance field
- `npy_labels.json`, when present, documents the upstream label meanings for the folder

If `.ply`, `.obj`, or `.stl` meshes are present in the selected pipeline directory, they are loaded with the volumes. For the current pipeline this usually includes both `voxel_input_mesh.ply` and `mesh.ply`. If meshes are missing, the viewer still shows the available slices.

The Field dropdown controls which loaded pipeline stage is shown. Fields are loaded on demand, so switching stages does not keep every `r=512` array in browser memory at the same time.

Meshes are rendered in their source coordinates by default. Enable **Normalize
imports to current size** in Options before using Add mesh or Remote Add to
uniformly scale each new mesh so its longest bounding-box edge matches the
currently loaded mesh bounds and both bounding-box centers align. If no current
mesh bounds are available, the imported mesh keeps its source coordinates.

Additional `.ply`, `.obj`, or `.stl` meshes can be added with Add mesh. The mesh visibility bar controls which meshes are visible.

## Remote Folders

The Remote panel defaults to `/mnt/bn/vai3d-hl-1/Users/lizd/work/floodfill/output` on `hl_gpu_2` through the local backend. The backend accepts only the exact SSH aliases `hl_gpu_2` and `126781` by default, uses the existing local SSH configuration, and only reads files. To use a different set, start the backend or desktop app with `REMOTE_VIEWER_ALLOWED_HOSTS` set to a comma-separated allowlist, for example `REMOTE_VIEWER_ALLOWED_HOSTS=hl_gpu_2,research_gpu`. Each configured entry must also be a valid SSH host alias.

1. Open Remote.
2. Browse or enter a server path.
3. Select Load current folder, or use a directory row's Load button to load that folder directly.

Remote folders use the same generic `.npy`, optional `fields.json`, and legacy
pipeline-preset rules as local folders. Meshes load when the folder is selected;
`.npy` fields are downloaded on demand when their Field entry is selected.
Remote mesh and `.npy` downloads show progress in the top bar. Downloaded remote files are stored in the browser's IndexedDB cache by remote path, size, and mtime, so loading the same unchanged remote file again avoids another SSH download without keeping every parsed volume in memory. Remote `.ply`, `.obj`, and `.stl` files can also be added directly from the Remote file list.
Use Download current folder, or a directory row's Download button, to prefetch
supported `.npy` fields plus mesh files into the browser cache without changing
the current view.

## Display

- Left: 3D mesh view with a slice plane transformed by the field's `indexToWorld` metadata. The mesh is clipped in Polyscope-style inspection, keeping the positive side of the active slice plane.
- Right: 2D color rendering of the selected field slice.

The slice renderer has two modes:

- Pixels: each grid point is drawn as one image pixel.
- Corner dots: each grid point is drawn as a small circle at its grid-node position. The 3D slice plane uses a transparent dot texture, and the right-side slice panel uses a scrollable dot canvas. For `r=512`, the right-side canvas is about `2053 x 2053`.

Options shows the resolved semantic, logical shape, source axis order, sampling
association, and coordinate source. These values can be overridden without
changing code, including a custom row-major `indexToWorld` matrix. Continuous
fields provide an adjustable range, isovalue, color map, and exact-slice
contours. Categorical fields provide current-slice counts plus search by exact
ID, name, or group, with hide, isolate, and locked-highlight controls. Click a
slice sample to pin its exact XYZ index and world position; switching X/Y/Z
keeps all three slice indices linked to that point.

Pipeline label arrays are sampled on grid nodes, not cell centers. Grid indices map to world space as:

```text
world = -1 + grid_index * 2 / (grid_dimension - 1)
```

The grid axes map directly to world axes: `[i, j, k] -> [x, y, z]`.

## Label Values

`000_initial_ccl_labels.npy` and `NNN_final_ccl_labels.npy`:

- `0` unknown/background
- `1` outside
- `2` inside
- `3` unresolved band
- `4` surface barrier

`MMM_inside_filtered_labels.npy`:

- `0` unknown/background
- `1` outside
- `2` inside

`NNN_final_ccl_components.npy`:

- `0` unknown/background
- `1` outside
- `2` inside
- `3` surface barrier
- `>=4` component ids encoded as `component_id + 3`

`NNN_final_ccl_cases.npy`:

- `0` unknown/background
- `1` outside
- `2` inside
- `3` surface barrier
- `4` inside-only case
- `5` outside-only case
- `6` both-sides case
- `7` isolated case

`SSS_surface_boundary_classification.npy`:

- `0` unknown/background
- `1` outside
- `2` inside
- `3` surface boundary classified inside
- `4` surface boundary classified outside

`999_scalar_field.npy`:

- signed scalar field used for mesh extraction
- positive values are outside, negative values are inside
- slice colors follow the server visualizer: zero is white, positive near zero trends red, negative near zero trends blue, and `|value| > 0.1` is black

`999_linf_distance_cases.npy`:

- L-infinity distance case ids emitted by the upstream pipeline
- the viewer displays each case id with a stable pseudo-random color and shows per-case counts for the current slice
- when `npy_labels.json` is present, the viewer uses the upstream manifest text for the case names in the legend and inspector

## Performance

This version does not render dense 3D field voxels. It renders one exact field
slice at a time, so an `r=512` pipeline output updates a `513 x 513` canvas
instead of creating voxel geometry.
