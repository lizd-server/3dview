# Interactive Mesh Slice Viewer

Client-side Three.js viewer for inspecting pipeline label slices against mesh geometry in the shared `[-1, 1]^3` coordinate system.

## Run

```bash
npm install
npm run dev
```

The dev command starts:

- frontend: `http://127.0.0.1:5173/`
- local remote-file backend: `http://127.0.0.1:5175/`

For a persistent local service managed by pm2:

```bash
npm run pm2:start
pm2 save
```

Useful pm2 commands:

- `pm2 status`
- `npm run pm2:logs`
- `npm run pm2:stop`

For a production build:

```bash
npm run build
```

## macOS App

Create and install the standalone Electron macOS app:

```bash
npm run mac:app
```

This writes `dist-mac/Voxel Mesh Viewer-darwin-<arch>/Voxel Mesh Viewer.app` and installs a copy to `~/Applications/Voxel Mesh Viewer.app`.

Double-clicking the app opens a native macOS application window, not an external browser. The packaged app serves the built frontend and the read-only remote-file API inside the Electron main process on an app-owned loopback port, so PM2, Vite, and fixed ports such as `5173`/`5175` are not required for normal app use.

## Input Folder

Use the Folder input and select one pipeline output directory. The viewer loads every supported `.npy` that is present, so incomplete debug folders can still be inspected. A complete final CCL stage includes:

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

The Array dropdown controls which loaded pipeline stage is shown. Volumes are loaded on demand, so switching stages does not keep every `r=512` array in browser memory at the same time.

Meshes are rendered in their source coordinates. The viewer does not normalize or remap mesh geometry.

Additional `.ply`, `.obj`, or `.stl` meshes can be added with Add mesh. The mesh visibility bar controls which meshes are visible.

## Remote Folders

The Remote panel defaults to `/mnt/bn/vai3d-hl-1/Users/lizd/work/floodfill/output` on `hl_gpu_2` through the local backend. The SSH host field is editable, so any safe local SSH alias such as `126781` can be used. The backend uses the existing local SSH configuration and only reads files.

1. Open Remote.
2. Browse or enter a server path.
3. Select Load current folder, or use a directory row's Load button to load that folder directly.

Remote folders use the same required and optional file names as local folders. Meshes load when the folder is selected; `.npy` volumes are downloaded on demand when their Array entry is selected.
Remote mesh and `.npy` downloads show progress in the top bar. Downloaded remote files are stored in the browser's IndexedDB cache by remote path, size, and mtime, so loading the same unchanged remote file again avoids another SSH download without keeping every parsed volume in memory. Remote `.ply`, `.obj`, and `.stl` files can also be added directly from the Remote file list.
Use Download current folder, or a directory row's Download button, to prefetch every recognized pipeline `.npy` plus mesh files into the browser cache without changing the current view.

## Display

- Left: 3D mesh view with an axis-aligned slice plane. The mesh is clipped in Polyscope-style inspection, keeping the positive side of the active slice plane.
- Right: 2D color rendering of the selected label slice.

The slice renderer has two modes:

- Pixels: each grid point is drawn as one image pixel.
- Corner dots: each grid point is drawn as a small circle at its grid-node position. The 3D slice plane uses a transparent dot texture, and the right-side slice panel uses a scrollable dot canvas. For `r=512`, the right-side canvas is about `2053 x 2053`.

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

This version does not render 3D label voxels. It renders one label slice at a time, so an `r=512` pipeline output updates a `513 x 513` canvas instead of creating voxel geometry.
