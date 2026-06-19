# Interactive Mesh Slice Viewer

Client-side Three.js viewer for debugging voxel label slices against mesh geometry in the shared `[-1, 1]^3` coordinate system.

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

## Supported Inputs

- Volumes: `.npy`, `.npz`
- Meshes: `.ply`, `.obj`, `.stl`

Meshes are shown in their source coordinates by default. Enable `Normalize mesh` only when you explicitly want to fit a mesh into the unit coordinate box.

The UI has two main panes:

- Left: 3D mesh view with a movable axis-aligned slice plane.
- Right: 2D color rendering of the label slice at the same plane position.

Drag or scroll the slice plane in the 3D view, or use the slice slider, to move the slice.

## Label Schemas

The viewer supports three schema modes:

- Pipeline labels: `0` unknown/background, `1` outside, `2` inside, `3` unresolved band, `4` surface barrier, `>=5` CCL components.
- CCL components: if loaded as a standalone volume, `0` unknown/background and nonzero labels are component ids with deterministic random colors.
- CCL cases: standalone `*_cases.npy` from the current pipeline is a composite case volume: `0` unknown/background, `1` outside, `2` inside, `3` surface barrier, `4` inside-only case, `5` outside-only case, `6` both-sides case, `7` isolated case.

If an `.npz` contains `outside` plus optional `inside`, `band`, and `surface_barrier` boolean arrays, the viewer synthesizes a `pipeline_labels` volume using the same constants as the server-side slice visualizer:

```text
0 UNKNOWN
1 OUTSIDE
2 INSIDE
3 BAND
4 SURFACE_BARRIER
```

If an `.npz` contains `outside` plus a raw unresolved-component case-id array named like `component_case` or `component_cases`, the viewer also synthesizes `ccl_cases_overlay`. That view follows the server-side component/case slice renderer:

```text
unknown background
inside / outside base colors
case ids where case > 0
surface barrier on top
```

Standalone `*_cases.npy` files already contain the composite CCL case view from the current pipeline. Export an `.npz` with raw masks only when you want the browser to synthesize the same overlay from intermediate arrays. For overlay synthesis, include at least:

```text
outside
component_case or component_cases
```

and preferably:

```text
inside
surface_barrier
```

Slice plane positions are mapped to world space as:

```text
world = -1 + (grid_index + 0.5) * 2 / grid_dimension
```

Use the axis order and flip controls when the array axis convention differs from the mesh convention.

## Performance Controls

This version does not render 3D label voxels. It renders only one 2D label slice at a time, so `r=512` volumes are handled by updating a `512 x 512` canvas instead of creating hundreds of thousands of 3D voxel boxes.
