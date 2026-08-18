#!/usr/bin/env python3
"""Prepare browser-friendly VXZ previews and exact grid-aligned slices."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import struct
import sys
import time
import uuid
from pathlib import Path
from typing import Literal, Sequence

import numpy as np
from numpy.typing import NDArray

import decode_vxz


Axis = Literal["x", "y", "z"]
AXIS_TO_INDEX: dict[Axis, int] = {"x": 0, "y": 1, "z": 2}
WORKER_FORMAT_VERSION = 3
CACHE_FORMAT_VERSION = 5
DEFAULT_POINT_BUDGET = 750_000
DEFAULT_MESH_FACE_BUDGET = 5_000_000

VOXEL_RECORD_DTYPE = np.dtype(
    [
        ("coords", "<u2", (3,)),
        ("dual", "u1", (3,)),
        ("intersected", "u1"),
        ("ovoxel_type", "u1"),
        ("qef_rank", "u1"),
    ],
    align=False,
)


def slice_pixel_to_grid(
    axis: Axis, index: int, px: int, py: int, resolution: int
) -> tuple[int, int, int]:
    inverted = resolution - 1 - py
    if axis == "x":
        return index, inverted, px
    if axis == "y":
        return px, index, inverted
    return px, inverted, index


def grid_to_slice_pixel(
    axis: Axis, coord: Sequence[int], resolution: int
) -> tuple[int, int]:
    x, y, z = (int(value) for value in coord)
    if axis == "x":
        return z, resolution - 1 - y
    if axis == "y":
        return x, resolution - 1 - z
    return x, resolution - 1 - y


def voxel_world_centers(coords: NDArray[np.integer], resolution: int) -> NDArray[np.float32]:
    centers = coords.astype(np.float32)
    centers += np.float32(0.5)
    centers /= np.float32(resolution)
    centers -= np.float32(0.5)
    return centers


def dual_world_vertices(
    coords: NDArray[np.integer], dual: NDArray[np.uint8], resolution: int
) -> NDArray[np.float32]:
    vertices = coords.astype(np.float32)
    vertices += dual.astype(np.float32) / np.float32(255.0)
    vertices /= np.float32(resolution)
    vertices -= np.float32(0.5)
    return vertices


def resolve_grid_resolution(
    coords: NDArray[np.integer], requested: int | None
) -> tuple[int, str]:
    if coords.size == 0:
        raise ValueError("cannot resolve an empty VXZ grid")
    max_coord = int(coords.max())
    if requested is None:
        return max_coord + 1, "inferred"
    if requested <= max_coord:
        raise ValueError(
            f"resolution {requested} does not contain maximum voxel coordinate {max_coord}"
        )
    return requested, "explicit"


def _voxel_records(
    coords: NDArray[np.integer],
    dual: NDArray[np.uint8],
    intersected: NDArray[np.uint8],
    ovoxel_type: NDArray[np.uint8],
    qef_rank: NDArray[np.uint8],
) -> np.ndarray:
    if coords.shape != (len(coords), 3) or dual.shape != (len(coords), 3):
        raise ValueError("coords and dual must have shape [N, 3]")
    if intersected.shape != (len(coords),):
        raise ValueError("intersected must have shape [N]")
    if ovoxel_type.shape != (len(coords),):
        raise ValueError("ovoxel_type must have shape [N]")
    if qef_rank.shape != (len(coords),):
        raise ValueError("qef_rank must have shape [N]")
    if len(coords) and (np.any(coords < 0) or np.any(coords > np.iinfo(np.uint16).max)):
        raise ValueError("browser voxel records require uint16 coordinates")
    records = np.empty(len(coords), dtype=VOXEL_RECORD_DTYPE)
    records["coords"] = coords
    records["dual"] = dual
    records["intersected"] = intersected
    records["ovoxel_type"] = ovoxel_type
    records["qef_rank"] = qef_rank
    return records


def build_voxel_payload(
    coords: NDArray[np.integer],
    dual: NDArray[np.uint8],
    intersected: NDArray[np.uint8],
    ovoxel_type: NDArray[np.uint8],
    qef_rank: NDArray[np.uint8],
    resolution: int,
) -> bytes:
    records = _voxel_records(coords, dual, intersected, ovoxel_type, qef_rank)
    header = struct.pack("<4sIII", b"VXVP", WORKER_FORMAT_VERSION, len(records), resolution)
    return header + records.tobytes()


def build_slice_payload(
    coords: NDArray[np.integer],
    dual: NDArray[np.uint8],
    intersected: NDArray[np.uint8],
    ovoxel_type: NDArray[np.uint8],
    qef_rank: NDArray[np.uint8],
    resolution: int,
    axis: Axis,
    index: int,
) -> bytes:
    if not 0 <= index < resolution:
        raise ValueError(f"slice index must be in [0, {resolution - 1}]")
    axis_index = AXIS_TO_INDEX[axis]
    selected = np.flatnonzero(coords[:, axis_index] == index)
    records = _voxel_records(
        coords[selected],
        dual[selected],
        intersected[selected],
        ovoxel_type[selected],
        qef_rank[selected],
    )
    header = struct.pack(
        "<4sIIIII",
        b"VXSL",
        WORKER_FORMAT_VERSION,
        len(records),
        resolution,
        axis_index,
        index,
    )
    return header + records.tobytes()


def build_mesh_payload(
    positions: NDArray[np.floating], indices: NDArray[np.integer]
) -> bytes:
    positions = np.asarray(positions, dtype="<f4")
    indices = np.asarray(indices, dtype="<u4").reshape(-1)
    if positions.ndim != 2 or positions.shape[1] != 3:
        raise ValueError("positions must have shape [N, 3]")
    if len(indices) and int(indices.max()) >= len(positions):
        raise ValueError("mesh index is outside the positions array")
    header = struct.pack(
        "<4sIII", b"VXMP", WORKER_FORMAT_VERSION, len(positions), len(indices)
    )
    return header + positions.tobytes() + indices.tobytes()


def _atomic_write_bytes(target: Path, payload: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        with staged.open("wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)


def _atomic_save_array(target: Path, value: np.ndarray) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        with staged.open("wb") as output:
            np.save(output, value, allow_pickle=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(staged, target)
    finally:
        staged.unlink(missing_ok=True)


def _progress(stage: str, fraction: float, message: str) -> None:
    print(
        "PROGRESS "
        + json.dumps(
            {
                "stage": stage,
                "fraction": max(0.0, min(1.0, float(fraction))),
                "message": message,
            },
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )


def _preview_indices(voxel_count: int, budget: int) -> NDArray[np.int64]:
    if budget <= 0:
        raise ValueError("point budget must be positive")
    if voxel_count <= budget:
        return np.arange(voxel_count, dtype=np.int64)
    stride = (voxel_count + budget - 1) // budget
    return np.arange(0, voxel_count, stride, dtype=np.int64)


def _cluster_vertex_map(
    coords: NDArray[np.integer],
    dual: NDArray[np.uint8],
    resolution: int,
    cluster_width: int,
) -> tuple[NDArray[np.float32], NDArray[np.int32]]:
    """Collapse nearby dual vertices without dropping isolated surface faces."""
    if cluster_width <= 0:
        raise ValueError("cluster width must be positive")

    # Work in exact 1/255-cell integer units. A dual value of 255 belongs to
    # the following cell, matching the decoded vertex position exactly.
    cluster_coords = coords.astype(np.int32, copy=True)
    cluster_coords *= 255
    cluster_coords += dual.astype(np.int32, copy=False)
    cluster_coords //= cluster_width * 255
    cluster_keys = decode_vxz._pack_coords(cluster_coords)
    _, inverse = np.unique(
        cluster_keys,
        return_inverse=True,
    )
    cluster_count = int(inverse.max()) + 1
    counts = np.bincount(inverse, minlength=cluster_count)
    positions = np.empty((cluster_count, 3), dtype=np.float32)
    for axis in range(3):
        local = coords[:, axis].astype(np.float64)
        local += dual[:, axis].astype(np.float64) / 255.0
        sums = np.bincount(inverse, weights=local, minlength=cluster_count)
        positions[:, axis] = (
            sums / counts / float(resolution) - 0.5
        ).astype(np.float32)
    return positions, inverse.astype(np.int32, copy=False)


def _deduplicate_triangles(
    triangles: NDArray[np.int32],
) -> NDArray[np.int32]:
    """Remove duplicate faces while preserving the first face's winding."""
    if not len(triangles):
        return triangles
    canonical = np.sort(triangles, axis=1)
    records = np.ascontiguousarray(canonical).view(
        np.dtype([("a", "<i4"), ("b", "<i4"), ("c", "<i4")])
    ).reshape(-1)
    _, first_indices = np.unique(records, return_index=True)
    return triangles[np.sort(first_indices)]


def _clustered_mesh_preview(
    coords: NDArray[np.int32],
    dual: NDArray[np.uint8],
    intersected: NDArray[np.uint8],
    resolution: int,
    keys: NDArray[np.uint64],
    sorted_keys: NDArray[np.uint64],
    sorted_to_original: NDArray[np.int64],
    quad_count: int,
    mesh_face_budget: int,
) -> tuple[NDArray[np.float32], NDArray[np.uint32], int]:
    # Surface triangle count scales approximately with the square of the
    # spatial clustering width. Unlike face sampling, clustering retains a
    # connected coarse surface that still reads as the decoded mesh.
    cluster_width = max(1, int(np.ceil(np.sqrt((quad_count * 2) / mesh_face_budget))))
    cluster_positions, vertex_clusters = _cluster_vertex_map(
        coords, dual, resolution, cluster_width
    )

    clustered_batches: list[NDArray[np.int32]] = []
    visited_quads = 0
    for quads in decode_vxz._candidate_batches(
        keys,
        intersected,
        sorted_keys,
        sorted_to_original,
        decode_vxz.DEFAULT_TOPOLOGY_BATCH_SIZE,
    ):
        exact_triangles = decode_vxz._triangulate_quads(
            quads, coords, dual, resolution
        )
        clustered = vertex_clusters[exact_triangles]
        nondegenerate = (
            (clustered[:, 0] != clustered[:, 1])
            & (clustered[:, 1] != clustered[:, 2])
            & (clustered[:, 2] != clustered[:, 0])
        )
        if nondegenerate.any():
            clustered_batches.append(clustered[nondegenerate])
        visited_quads += len(quads)
        _progress(
            "mesh",
            0.5 + 0.24 * visited_quads / quad_count,
            f"Clustering decoded mesh {visited_quads:,}/{quad_count:,} quads",
        )

    triangles = _deduplicate_triangles(np.concatenate(clustered_batches, axis=0))
    used_vertices, remapped = np.unique(triangles.reshape(-1), return_inverse=True)
    positions = cluster_positions[used_vertices]
    return positions, remapped.astype(np.uint32, copy=False), cluster_width


def prepare_cache(
    source: Path,
    cache_dir: Path,
    point_budget: int = DEFAULT_POINT_BUDGET,
    mesh_face_budget: int = DEFAULT_MESH_FACE_BUDGET,
    resolution: int | None = None,
) -> dict[str, object]:
    started = time.perf_counter()
    cache_dir.mkdir(parents=True, exist_ok=True)
    metadata_path = cache_dir / "metadata.json"
    if metadata_path.is_file():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if (
            metadata.get("formatVersion") == WORKER_FORMAT_VERSION
            and metadata.get("cacheVersion") == CACHE_FORMAT_VERSION
            and (resolution is None or metadata.get("resolution") == resolution)
        ):
            _progress("ready", 1.0, "Using cached VXZ data")
            return metadata

    _progress("read", 0.02, "Reading VXZ chunks")
    with contextlib.redirect_stdout(sys.stderr):
        data = decode_vxz.read_vxz(source)
    resolution, resolution_source = resolve_grid_resolution(data.coords, resolution)
    if resolution > np.iinfo(np.uint16).max:
        raise ValueError(f"resolution {resolution} exceeds the browser uint16 contract")

    _progress("cache", 0.24, "Caching exact sparse voxel attributes")
    _atomic_save_array(cache_dir / "coords.npy", data.coords)
    _atomic_save_array(cache_dir / "dual.npy", data.dual_vertices)
    _atomic_save_array(cache_dir / "intersected.npy", data.intersected)
    _atomic_save_array(cache_dir / "ovoxel_type.npy", data.ovoxel_type)
    _atomic_save_array(cache_dir / "qef_rank.npy", data.qef_rank)

    preview_indices = _preview_indices(len(data.coords), point_budget)
    voxel_payload = build_voxel_payload(
        data.coords[preview_indices],
        data.dual_vertices[preview_indices],
        data.intersected[preview_indices],
        data.ovoxel_type[preview_indices],
        data.qef_rank[preview_indices],
        resolution,
    )
    _atomic_write_bytes(cache_dir / "voxels.bin", voxel_payload)
    del voxel_payload

    _progress("topology", 0.34, "Building exact coordinate index")
    keys = decode_vxz._pack_coords(data.coords)
    sorted_to_original = np.argsort(keys, kind="stable")
    sorted_keys = keys[sorted_to_original]
    if len(sorted_keys) > 1 and np.any(sorted_keys[1:] == sorted_keys[:-1]):
        raise ValueError("VXZ contains duplicate voxel coordinates")

    _progress("topology", 0.43, "Counting signed dual-grid faces")
    quad_count = sum(
        len(quads)
        for quads in decode_vxz._candidate_batches(
            keys,
            data.intersected,
            sorted_keys,
            sorted_to_original,
            decode_vxz.DEFAULT_TOPOLOGY_BATCH_SIZE,
        )
    )
    if quad_count == 0:
        raise ValueError("decoded mesh has no valid dual-grid quads")

    positions, remapped, cluster_width = _clustered_mesh_preview(
        data.coords,
        data.dual_vertices,
        data.intersected,
        resolution,
        keys,
        sorted_keys,
        sorted_to_original,
        quad_count,
        mesh_face_budget,
    )
    mesh_payload = build_mesh_payload(positions, remapped)
    _atomic_write_bytes(cache_dir / "mesh.bin", mesh_payload)

    bounds_min = dual_world_vertices(
        data.coords, data.dual_vertices, resolution
    ).min(axis=0)
    bounds_max = dual_world_vertices(
        data.coords, data.dual_vertices, resolution
    ).max(axis=0)
    metadata: dict[str, object] = {
        "formatVersion": WORKER_FORMAT_VERSION,
        "cacheVersion": CACHE_FORMAT_VERSION,
        "sourceName": source.name,
        "resolution": resolution,
        "resolutionSource": resolution_source,
        "voxelCount": len(data.coords),
        "quadCount": quad_count,
        "faceCount": quad_count * 2,
        "previewVoxelCount": len(preview_indices),
        "previewVertexCount": len(positions),
        "previewFaceCount": len(remapped) // 3,
        "previewMode": "vertex-clustered",
        "previewClusterWidth": cluster_width,
        "hasOvoxelType": bool(np.any(data.ovoxel_type != decode_vxz.MISSING_OVOXEL_TYPE)),
        "ovoxelTypeCounts": [
            int(np.count_nonzero(data.ovoxel_type == case)) for case in range(4)
        ],
        "hasQefRank": bool(np.any(data.qef_rank != decode_vxz.MISSING_QEF_RANK)),
        "qefRankCounts": [
            int(np.count_nonzero(data.qef_rank == rank)) for rank in range(4)
        ],
        "boundsMin": bounds_min.tolist(),
        "boundsMax": bounds_max.tolist(),
        "gridMin": data.coords.min(axis=0).tolist(),
        "gridMax": data.coords.max(axis=0).tolist(),
        "elapsedSeconds": time.perf_counter() - started,
    }
    _atomic_write_bytes(
        metadata_path,
        json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"),
    )
    _progress("ready", 1.0, "VXZ mesh and voxel views are ready")
    return metadata


def load_cached_arrays(
    cache_dir: Path,
) -> tuple[
    NDArray[np.int32],
    NDArray[np.uint8],
    NDArray[np.uint8],
    NDArray[np.uint8],
    NDArray[np.uint8],
    dict[str, object],
]:
    metadata = json.loads((cache_dir / "metadata.json").read_text(encoding="utf-8"))
    coords = np.load(cache_dir / "coords.npy", mmap_mode="r", allow_pickle=False)
    dual = np.load(cache_dir / "dual.npy", mmap_mode="r", allow_pickle=False)
    intersected = np.load(
        cache_dir / "intersected.npy", mmap_mode="r", allow_pickle=False
    )
    ovoxel_type = np.load(
        cache_dir / "ovoxel_type.npy", mmap_mode="r", allow_pickle=False
    )
    qef_rank = np.load(cache_dir / "qef_rank.npy", mmap_mode="r", allow_pickle=False)
    return coords, dual, intersected, ovoxel_type, qef_rank, metadata


def slice_from_cache(cache_dir: Path, axis: Axis, index: int) -> bytes:
    coords, dual, intersected, ovoxel_type, qef_rank, metadata = load_cached_arrays(
        cache_dir
    )
    return build_slice_payload(
        coords,
        dual,
        intersected,
        ovoxel_type,
        qef_rank,
        int(metadata["resolution"]),
        axis,
        index,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="prepare browser preview/cache files")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("cache_dir", type=Path)
    prepare.add_argument("--point-budget", type=int, default=DEFAULT_POINT_BUDGET)
    prepare.add_argument(
        "--mesh-face-budget", type=int, default=DEFAULT_MESH_FACE_BUDGET
    )
    prepare.add_argument("--resolution", type=int)

    slice_parser = subparsers.add_parser("slice", help="write one exact grid slice")
    slice_parser.add_argument("cache_dir", type=Path)
    slice_parser.add_argument("axis", choices=tuple(AXIS_TO_INDEX))
    slice_parser.add_argument("index", type=int)

    args = parser.parse_args()
    if args.command == "prepare":
        metadata = prepare_cache(
            args.source,
            args.cache_dir,
            point_budget=args.point_budget,
            mesh_face_budget=args.mesh_face_budget,
            resolution=args.resolution,
        )
        print(json.dumps(metadata, ensure_ascii=False))
        return 0

    payload = slice_from_cache(args.cache_dir, args.axis, args.index)
    sys.stdout.buffer.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
