# Data Producer Guide

This document is the data contract for programs that generate fields for
3DView. A producer should create one output directory containing one or more
three-dimensional NumPy arrays, one `fields.json` manifest, and any optional
reference meshes.

Following this contract makes the dataset self-describing. The viewer can then
answer four questions without relying on a pipeline-specific filename:

- What does the value at this location mean?
- Why is this region assigned to this category?
- Which locations changed between stages?
- Do label boundaries and the source geometry share the same coordinates?

## Required output contract

A producer should:

1. Write each field as a numeric, rank-3 `.npy` array.
2. Write `fields.json` in the same directory.
3. Declare `semantic`, `axisOrder`, `association`, and a coordinate mapping.
4. Preserve categorical IDs as integers; never normalize or interpolate them.
5. Put every field and mesh that should align in one shared world coordinate
   system.
6. Write files atomically when the viewer may inspect a running job.

A typical output directory is:

```text
run-0042/
  fields.json
  000_raw_labels.npy
  010_final_labels.npy
  010_component_id.npy
  010_sdf.npy
  input_mesh.ply
```

Names are arbitrary. A three-digit stage prefix such as `000_` or `010_` is
recommended when field order matters. The viewer also sorts unprefixed names,
but a prefix makes stage order explicit to people and other tools.

Open the directory, rather than one individual `.npy` file, when all fields and
meshes should be available together. Opening an individual `.npy` file directly
loads that field and its neighboring metadata only.

## NumPy array requirements

The viewer accepts NumPy format versions 1, 2, and 3 with exactly three
positive dimensions.

| Data | Supported NumPy dtypes |
| --- | --- |
| Boolean | `bool` / `b1` |
| Signed integer | `int8`, `int16`, `int32`, `int64` |
| Unsigned integer | `uint8`, `uint16`, `uint32`, `uint64` |
| Floating point | `float16`, `float32`, `float64` |

Little-endian, big-endian, C-order, and Fortran-order arrays are supported.
For the broadest compatibility with other tools, producers should normally
write native little-endian, C-contiguous arrays with `numpy.save`.

The following are not accepted as fields:

- Rank-2 images or rank-4 batches/channels
- `.npz` archives
- Object, string, structured, or complex arrays
- Pickled Python objects

Use the smallest dtype that preserves the required values. A `1024 x 1024 x
1024` `uint32` field is 4 GiB before parsing, caching, or GPU use. Remote fields
are fetched on demand, but the selected `.npy` field is still a complete array.

Categorical data should use an integer dtype. `int64` and `uint64` label IDs are
preserved exactly, including IDs above JavaScript's safe integer range. Do not
store integer identities in `float32`; large or nearby IDs can collapse to the
same floating-point value.

## `fields.json`

Always emit this manifest, even when dtype-based inference would happen to be
correct. The recommended top-level form is:

```json
{
  "version": 1,
  "defaults": {},
  "fields": {
    "field-name.npy": {}
  }
}
```

`defaults` applies to every listed field. A field entry overrides any default.
Keys under `fields` are matched by basename, so use the exact filename and do
not depend on case-insensitive matching.

### Metadata fields

| Key | Values | Meaning |
| --- | --- | --- |
| `semantic` | `"categorical"`, `"continuous"` | Whether values are identities or magnitudes |
| `categoricalPreset` | `"semantic"`, `"instances"` | UI behavior for a small schema or many IDs |
| `axisOrder` | e.g. `"zyx"` | Logical axis represented by each NumPy dimension |
| `association` | `"point"`, `"cell"` | Values live on grid nodes or cell centers |
| `coordinatePreset` | `"index"`, `"normalized"` | Built-in index-to-world mapping |
| `indexToWorld` | 16 numbers | Explicit row-major affine mapping |
| `labels` | object keyed by exact ID | Names, colors, groups, and initial visibility |
| `continuousStyle` | object | Range, center, scale, colors, and isovalue |
| `validity` | object | Exact values that mean missing or invalid data |
| `sparseDefault` | exact value string | Value used for absent samples in a sparse source |
| `valueDescription` | string | Human-readable meaning, units, and sign convention |

`sourceAxisOrder` is also accepted as the long form of `axisOrder`. Producers
should use one spelling consistently.

## Axis order and logical shape

Viewer coordinates are always logical XYZ. `axisOrder` describes the source
array dimensions from first to last.

For the common NumPy layout below:

```python
labels = np.zeros((nz, ny, nx), dtype=np.uint16)
```

write:

```json
{ "axisOrder": "zyx" }
```

The source shape `[Z, Y, X]` is then exposed as logical shape `[X, Y, Z]`.
`"xyz"` means the source is already shaped `[X, Y, Z]`. Every axis order must
be a permutation of X, Y, and Z. An array form such as `["z", "y", "x"]` is
also accepted.

Axis order changes indexing only. It does not rotate a mesh or change the world
coordinate system. The `indexToWorld` matrix always receives logical
`[x, y, z, 1]`, regardless of NumPy storage order.

## Point samples and cell samples

Declare where every array value lives:

- `"association": "point"` means element `(x, y, z)` is sampled at a grid
  node. A logical dimension of size `N` spans node indices `0` through `N - 1`.
- `"association": "cell"` means element `(x, y, z)` represents a cell and is
  located at that cell's center. Its logical cell domain spans faces from
  `-0.5` through `N - 0.5`.

Do not use `point` merely because an array has values at integer indices. The
choice describes the physical sampling model and determines slice placement,
grid bounds, mesh intersections, and future interface extraction.

## Coordinate mappings

Physical or rotated data should use `indexToWorld`. It is a row-major 4 x 4
matrix applied to a logical sample index:

```text
[world_x, world_y, world_z, w] = indexToWorld * [x, y, z, 1]
```

For an axis-aligned grid with sample spacing `(sx, sy, sz)` and the world
position `(ox, oy, oz)` of sample `(0, 0, 0)`, use:

```json
{
  "indexToWorld": [
    0.01, 0,    0,    -0.995,
    0,    0.01, 0,    -1.995,
    0,    0,    0.02, -2.990,
    0,    0,    0,     1
  ]
}
```

The first three columns are the world displacement for one logical X, Y, or Z
step. This also supports rotation and shear. The fourth column is the world
position of logical sample `(0, 0, 0)`. All entries must be finite and the last
row must be `[0, 0, 0, 1]`.

For a cell field, `indexToWorld` maps integer indices to **cell centers**. If
your simulation stores the corner of cell `(0, 0, 0)`, convert it before writing
the matrix:

```text
sample_origin = corner_origin + 0.5 * x_basis
                              + 0.5 * y_basis
                              + 0.5 * z_basis
```

For the axis-aligned example, a corner origin of `(-1, -2, -3)` and cell size
`(0.01, 0.01, 0.02)` gives the sample origin
`(-0.995, -1.995, -2.990)` shown above.

When physical coordinates are unavailable, use one of these explicit presets:

- `"coordinatePreset": "index"`: point samples are at `i`; cell samples are
  at `i + 0.5`.
- `"coordinatePreset": "normalized"`: each complete grid domain spans
  `[-1, 1]`. Point index `i` maps to `-1 + 2i/(N-1)`; cell index `i` maps to
  `-1 + 2(i+0.5)/N`. A singleton point axis (`N = 1`) maps its only sample to
  zero.

`indexToWorld` takes precedence if both forms are present. Producers should
write only one. Use normalized coordinates only when they are the actual shared
coordinate convention; do not normalize each field or mesh independently just
to make them appear similar in size.

Fields in one directory may have different shapes, associations, or transforms.
Put a shared mapping in `defaults` only when it is correct for every field, and
override it per field otherwise. Fields intended for direct point-by-point or
stage comparison should have the same logical sampling locations. A point field
and a cell field on the same underlying grid normally require different
translations because their samples are half a cell apart.

## Categorical fields

Use `"semantic": "categorical"` for class labels, masks, component IDs, part
IDs, algorithm cases, and any other identity. The numeric ordering of IDs has no
meaning: label 103 is not stronger than label 7.

Use `"categoricalPreset": "semantic"` for a relatively small, named set of
classes. Use `"instances"` for component or instance IDs where search,
isolation, and counts matter more than a large hand-authored color table.

Label metadata is keyed by the exact stored value:

```json
{
  "semantic": "categorical",
  "categoricalPreset": "semantic",
  "valueDescription": "Final region classification",
  "labels": {
    "0": {
      "name": "outside",
      "color": "#2563eb",
      "group": "region"
    },
    "1": {
      "name": "inside",
      "color": "#dc2626",
      "group": "region"
    }
  }
}
```

Each label can contain:

| Key | Meaning |
| --- | --- |
| `name` | Human-readable label name |
| `color` | Stable six-digit hex color such as `#2563eb` |
| `group` | Optional logical group |
| `background` | Marks this ID as a background category |
| `hidden` | Hides this ID initially |

No ID, including zero, is implicitly background. Declare it explicitly when
that is the intended meaning. Multiple background categories are allowed.

JSON keys are strings, which is also how exact IDs should be represented. IDs
outside the safe integer range must remain quoted decimal strings in every
metadata field:

```json
{
  "labels": {
    "9007199254740993": { "name": "large exact ID" }
  }
}
```

If component IDs are compared across stages, keep them stable when the
algorithm permits. When a stage renumbers components, the producer must not
describe raw ID inequality as a geometric change; a separate matching or
remapping step is needed.

## Continuous fields

Use `"semantic": "continuous"` for SDF, distance, confidence, probability,
error, density, and other magnitudes. Record units and sign conventions in
`valueDescription`.

```json
{
  "semantic": "continuous",
  "valueDescription": "Signed distance in metres; negative is inside",
  "continuousStyle": {
    "range": [-0.05, 0.05],
    "center": 0,
    "scale": "linear",
    "negativeColor": "#2563eb",
    "centerColor": "#ffffff",
    "positiveColor": "#dc2626",
    "outOfRangeColor": "#000000",
    "isovalue": 0
  }
}
```

`range` must contain two increasing finite numbers. Set it to `null` to request
an automatic range over valid values. `scale` can be `linear` or `sqrt`.

## Missing data, background, and sparse defaults

These concepts are different and producers should keep them separate:

- A **background label** is valid categorical data and participates in the
  field's meaning.
- A **no-data value** means the algorithm did not produce a valid sample. It is
  excluded from label counts, automatic continuous ranges, and contour
  interpolation.
- `sparseDefault` records the value inserted where an original sparse domain
  had no stored sample. It does not automatically mean background or no-data.
- A field that has not been downloaded or loaded is viewer state and must not
  be encoded as a label.

Declare exact no-data values as strings:

```json
{
  "validity": {
    "noDataValues": ["65535"],
    "description": "Cells not evaluated by this stage"
  }
}
```

For floating arrays, JSON cannot contain `NaN` or infinity as numbers. Use the
exact strings `"NaN"`, `"Infinity"`, or `"-Infinity"` when they are intentional
sentinels.

## Reference meshes

Optional `.ply`, `.obj`, and `.stl` files in the output directory can be loaded
with the fields. The mesh vertices must use the same world coordinate system as
the arrays' `indexToWorld` mappings.

For a cell field, cell boundaries lie half a logical step from each cell
center. For a point field, samples lie directly on grid nodes. Check this before
exporting the mesh; an accidental half-cell translation is one of the most
common causes of a plausible-looking but incorrect overlay.

The viewer can offer a visual normalization aid, but a producer must not depend
on it for correctness. Properly authored data aligns without per-object
normalization.

## Complete `fields.json` example

This example describes three cell-centered arrays stored in NumPy ZYX order on
the same physical grid:

```json
{
  "version": 1,
  "defaults": {
    "axisOrder": "zyx",
    "association": "cell",
    "indexToWorld": [
      0.01, 0,    0,    -0.995,
      0,    0.01, 0,    -1.995,
      0,    0,    0.02, -2.990,
      0,    0,    0,     1
    ]
  },
  "fields": {
    "010_final_labels.npy": {
      "semantic": "categorical",
      "categoricalPreset": "semantic",
      "valueDescription": "Final inside/outside classification",
      "validity": {
        "noDataValues": ["65535"],
        "description": "Not evaluated"
      },
      "labels": {
        "0": {
          "name": "outside",
          "color": "#2563eb"
        },
        "1": {
          "name": "inside",
          "color": "#dc2626"
        }
      }
    },
    "010_component_id.npy": {
      "semantic": "categorical",
      "categoricalPreset": "instances",
      "valueDescription": "Connected-component identity",
      "sparseDefault": "0",
      "labels": {
        "0": {
          "name": "background",
          "background": true,
          "hidden": true
        }
      }
    },
    "010_sdf.npy": {
      "semantic": "continuous",
      "valueDescription": "Signed distance in metres; negative is inside",
      "validity": {
        "noDataValues": ["NaN"],
        "description": "Uncomputed cells"
      },
      "continuousStyle": {
        "range": [-0.05, 0.05],
        "center": 0,
        "scale": "linear",
        "negativeColor": "#2563eb",
        "centerColor": "#ffffff",
        "positiveColor": "#dc2626",
        "outOfRangeColor": "#000000",
        "isovalue": 0
      }
    }
  }
}
```

## Copyable Python producer

The following example writes the three fields above. Replace the placeholder
array calculations with the generating algorithm.

```python
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np


OUTPUT = Path("run-0042")
OUTPUT.mkdir(parents=True, exist_ok=True)

# NumPy storage order is [Z, Y, X].
nz, ny, nx = 96, 128, 160
labels = np.zeros((nz, ny, nx), dtype=np.uint16)
components = np.zeros((nz, ny, nx), dtype=np.uint32)
sdf = np.full((nz, ny, nx), np.nan, dtype=np.float32)

# Replace these lines with real algorithm output.
labels[20:70, 30:100, 40:120] = 1
components[20:70, 30:100, 40:120] = 172
sdf[20:70, 30:100, 40:120] = -0.0031


def save_npy_atomic(path: Path, array: np.ndarray) -> None:
    """Expose either the old complete file or the new complete file."""
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("wb") as stream:
        np.save(stream, np.ascontiguousarray(array), allow_pickle=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def save_json_atomic(path: Path, value: object) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


save_npy_atomic(OUTPUT / "010_final_labels.npy", labels)
save_npy_atomic(OUTPUT / "010_component_id.npy", components)
save_npy_atomic(OUTPUT / "010_sdf.npy", sdf)

manifest = {
    "version": 1,
    "defaults": {
        "axisOrder": "zyx",
        "association": "cell",
        # Cell-corner origin is (-1, -2, -3); translation below is
        # the center of cell (0, 0, 0).
        "indexToWorld": [
            0.01, 0, 0, -0.995,
            0, 0.01, 0, -1.995,
            0, 0, 0.02, -2.990,
            0, 0, 0, 1,
        ],
    },
    "fields": {
        "010_final_labels.npy": {
            "semantic": "categorical",
            "categoricalPreset": "semantic",
            "valueDescription": "Final inside/outside classification",
            "validity": {
                "noDataValues": ["65535"],
                "description": "Not evaluated",
            },
            "labels": {
                "0": {"name": "outside", "color": "#2563eb"},
                "1": {"name": "inside", "color": "#dc2626"},
            },
        },
        "010_component_id.npy": {
            "semantic": "categorical",
            "categoricalPreset": "instances",
            "valueDescription": "Connected-component identity",
            "sparseDefault": "0",
            "labels": {
                "0": {
                    "name": "background",
                    "background": True,
                    "hidden": True,
                }
            },
        },
        "010_sdf.npy": {
            "semantic": "continuous",
            "valueDescription": "Signed distance in metres; negative is inside",
            "validity": {
                "noDataValues": ["NaN"],
                "description": "Uncomputed cells",
            },
            "continuousStyle": {
                "range": [-0.05, 0.05],
                "center": 0,
                "scale": "linear",
                "negativeColor": "#2563eb",
                "centerColor": "#ffffff",
                "positiveColor": "#dc2626",
                "outOfRangeColor": "#000000",
                "isovalue": 0,
            },
        },
    },
}

# Write metadata last so a newly visible manifest refers only to complete arrays.
save_json_atomic(OUTPUT / "fields.json", manifest)
```

The sentinel `65535` is reserved by the manifest but is not assigned in this
small example. A real producer may fill unevaluated label cells with that value.

## Safe output from running and remote jobs

The app may read a directory while a generator is still working, especially
over SSH. Never stream a new array directly into its final `.npy` pathname.
Write to a temporary name, flush and close it, then atomically replace the final
file. Write `fields.json` last. Atomic file replacement prevents partial files;
it does not make a multi-file update transactional. To publish a coherent new
run in one step, generate it in a staging directory and rename that directory
to its final run name after every file is complete.

Remote output follows the same directory contract. The remote machine must be
reachable through the user's normal SSH configuration, and the selected remote
directory must contain the `.npy` files and manifest together. Ordinary SSH
authentication, aliases, jump hosts, identity files, and included SSH config
files remain deployment concerns rather than fields in this manifest. The
remote host must also provide `python3` on `PATH`, which the viewer uses for
read-only directory and file access over SSH.

## Producer validation checklist

Before publishing a run, verify all of the following:

- Every `.npy` array has exactly three positive dimensions.
- Every dtype is numeric and supported; loading never requires pickle.
- `fields.json` is valid UTF-8 JSON and lists exact basenames.
- `axisOrder` matches the actual NumPy dimension order.
- `association` matches the algorithm's sampling model.
- `indexToWorld` maps logical XYZ sample indices, not source-array ZYX indices.
- A cell-centered mapping includes the half-cell offset when its input origin is
  a cell corner.
- Categorical IDs use integer arrays and retain their original values.
- Every background ID is explicitly marked; no-data is declared separately.
- Continuous fields document units and sign conventions.
- Fields intended for comparison share compatible world coordinates.
- Reference mesh vertices already use those same world coordinates.
- Final files replace temporary files atomically.

A lightweight local check is:

```python
import json
from pathlib import Path

import numpy as np

root = Path("run-0042")
manifest = json.loads((root / "fields.json").read_text(encoding="utf-8"))
supported_dtypes = {
    ("b", 1),
    *((kind, size) for kind in "iu" for size in (1, 2, 4, 8)),
    *(("f", size) for size in (2, 4, 8)),
}

for name in manifest["fields"]:
    path = root / name
    array = np.load(path, mmap_mode="r", allow_pickle=False)
    assert array.ndim == 3, (name, array.shape)
    assert all(size > 0 for size in array.shape), (name, array.shape)
    assert (array.dtype.kind, array.dtype.itemsize) in supported_dtypes, (
        name,
        array.dtype,
    )
    print(name, array.shape, array.dtype)
```

After this structural check, open the directory in 3DView and inspect at least
two known landmarks: sample `(0, 0, 0)` and one far corner or mesh feature. That
final check catches transposed axes, sign errors, unit mismatches, and half-cell
offsets that file-format validation cannot detect.
