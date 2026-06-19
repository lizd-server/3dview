# Interactive Voxel And Mesh Viewer

Client-side Three.js viewer for debugging voxel label volumes against mesh geometry in the shared `[-1, 1]^3` coordinate system.

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

## Label Schemas

The viewer supports three schema modes:

- Pipeline labels: `0` unknown/background, `1` outside, `2` inside, `3` unresolved band, `4` surface barrier, `>=5` CCL components.
- CCL components: `0` unknown/background, nonzero labels as component ids with deterministic random colors.
- CCL cases: `0` unknown/background, `1` inside-only, `2` outside-only, `3` both-sides, `4` isolated, other nonzero labels as components.

If an `.npz` contains `outside` plus optional `inside`, `band`, and `surface_barrier` boolean arrays, the viewer synthesizes a `pipeline_labels` volume using the same constants as the server-side slice visualizer:

```text
0 UNKNOWN
1 OUTSIDE
2 INSIDE
3 BAND
4 SURFACE_BARRIER
```

Voxel centers are mapped to world space as:

```text
world = -1 + (grid_index + 0.5) * 2 / grid_dimension
```

Use the axis order and flip controls when the array axis convention differs from the mesh convention.

## Performance Controls

Large volumes can be inspected with:

- Boundary-only voxel extraction.
- Sparse/downsampled rendering via sample step.
- Axis-aligned x/y/z slicing.
- A hard cap on emitted voxel boxes.
- Worker-backed extraction so filtering does not block the render loop.
