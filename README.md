# Interactive Mesh Slice Viewer

Client-side Three.js viewer for inspecting pipeline label slices against mesh geometry in the shared `[-1, 1]^3` coordinate system.

## Run

```bash
npm install
npm run dev
```

The dev server defaults to `http://127.0.0.1:5173/`.

For a production build:

```bash
npm run build
```

## Input Folder

Use the Folder input and select one pipeline output directory. The directory must contain:

- `NNN_final_ccl_labels.npy`
- `NNN_final_ccl_components.npy`
- `NNN_final_ccl_cases.npy`
- `voxel_input_mesh.ply`

The viewer also loads optional later-stage label volumes when they are present:

- `MMM_inside_filtered_labels.npy`, with `MMM = NNN + 1`
- `KKK_boundary_voted_labels.npy`, with `KKK = NNN + 2`

The Array dropdown controls which loaded pipeline stage is shown. Volumes are loaded on demand, so switching stages does not keep every `r=512` array in browser memory at the same time.

Meshes are rendered in their source coordinates. The viewer does not normalize or remap mesh geometry.

Additional `.ply`, `.obj`, or `.stl` meshes can be added with Add mesh. The mesh visibility bar controls which meshes are visible.

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

`NNN_final_ccl_labels.npy`, `MMM_inside_filtered_labels.npy`, and `KKK_boundary_voted_labels.npy`:

- `0` unknown/background
- `1` outside
- `2` inside
- `3` unresolved band
- `4` surface barrier

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

## Performance

This version does not render 3D label voxels. It renders one label slice at a time, so an `r=512` pipeline output updates a `513 x 513` canvas instead of creating voxel geometry.
