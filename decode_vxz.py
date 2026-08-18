#!/usr/bin/env python3
"""Decode O-Voxel VXZ files to binary PLY meshes on CPU.

This is a local, CUDA-free implementation of the ``decode_vxz.py`` flow from
``lizhuodong/ovoxel_produce``.  It follows the signed Flexible Dual Grid
topology used by ``gameAI-cvcg/trellis`` and only needs NumPy.

Examples:
    python3 decode_vxz.py model.vxz decoded
    python3 decode_vxz.py /path/to/folder decoded --resolution auto
    python3 decode_vxz.py vxz_files.txt decoded --resolution 1536
"""

from __future__ import annotations

import argparse
import json
import lzma
import mmap
import os
import struct
import sys
import time
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

import numpy as np
from numpy.typing import NDArray


UINT8 = NDArray[np.uint8]
UINT32 = NDArray[np.uint32]
UINT64 = NDArray[np.uint64]
INT32 = NDArray[np.int32]

VXZ_MAGIC = b"VXZ"
VXZ_VERSION = 0
SUPPORTED_FILTER = "none"
REQUIRED_ATTRIBUTES = {"dual_vertices": 3, "intersected": 1}
OPTIONAL_OVOXEL_TYPE_ATTRIBUTE = "ovoxel_type"
MISSING_OVOXEL_TYPE = np.uint8(255)
DEFAULT_TOPOLOGY_BATCH_SIZE = 500_000
MORTON_MASK = np.uint32(0x49249249)
MORTON_SHIFT = np.uint64(21)
PACKED_COORD_MASK = np.uint64((1 << 21) - 1)
AXIS_PRESENCE_BITS = np.array([1, 2, 4], dtype=np.uint8)
AXIS_POSITIVE_BITS = np.array([8, 16, 32], dtype=np.uint8)

# The four active voxels around an intersected x/y/z grid edge.  Packing a
# coordinate as x<<42 | y<<21 | z makes the offsets simple integer additions.
EDGE_NEIGHBOR_KEY_OFFSETS = np.array(
    [
        [0, 1, (1 << 21) + 1, 1 << 21],
        [0, 1 << 42, (1 << 42) + 1, 1],
        [0, 1 << 21, (1 << 42) + (1 << 21), 1 << 42],
    ],
    dtype=np.uint64,
)

PLY_FACE_DTYPE = np.dtype(
    [("vertex_count", "u1"), ("vertex_indices", "<i4", (3,))], align=False
)


@dataclass(frozen=True)
class VxzHeader:
    binary_start: int
    num_voxel: int
    chunk_size: int
    filter: str
    compression: str
    compression_level: int | None
    attr_interleave: str
    attributes: tuple[tuple[str, int], ...]
    chunks: tuple[dict[str, object], ...]


@dataclass(frozen=True)
class VxzData:
    coords: INT32
    dual_vertices: UINT8
    intersected: UINT8
    ovoxel_type: UINT8
    header: VxzHeader


@dataclass(frozen=True)
class InputItem:
    source: Path
    relative_output: Path


def _parse_header(file: object, source: Path) -> VxzHeader:
    prefix = file.read(8)  # type: ignore[attr-defined]
    if len(prefix) != 8 or prefix[:3] != VXZ_MAGIC:
        raise ValueError(f"not a VXZ file: {source}")
    if prefix[3] != VXZ_VERSION:
        raise ValueError(f"unsupported VXZ version {prefix[3]}: {source}")

    binary_start = struct.unpack(">I", prefix[4:8])[0]
    if binary_start < 8:
        raise ValueError(f"invalid VXZ binary offset {binary_start}: {source}")
    raw_structure = file.read(binary_start - 8)  # type: ignore[attr-defined]
    try:
        structure = json.loads(raw_structure)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid VXZ JSON header: {source}: {exc}") from exc

    try:
        attributes = tuple((str(name), int(channels)) for name, channels in structure["attr"])
        chunks = tuple(structure["chunks"])
        header = VxzHeader(
            binary_start=binary_start,
            num_voxel=int(structure["num_voxel"]),
            chunk_size=int(structure["chunk_size"]),
            filter=str(structure["filter"]),
            compression=str(structure["compression"]),
            compression_level=(
                None
                if structure.get("compression_level") is None
                else int(structure["compression_level"])
            ),
            attr_interleave=str(structure["attr_interleave"]),
            attributes=attributes,
            chunks=chunks,
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"incomplete VXZ header: {source}: {exc}") from exc

    if header.num_voxel <= 0:
        raise ValueError(f"VXZ contains no voxels: {source}")
    if header.chunk_size <= 0 or header.chunk_size & (header.chunk_size - 1):
        raise ValueError(f"VXZ chunk_size must be a power of two: {header.chunk_size}")
    if header.filter != SUPPORTED_FILTER:
        raise ValueError(
            f"unsupported VXZ filter {header.filter!r}; this CPU decoder currently "
            f"supports {SUPPORTED_FILTER!r}"
        )
    for name, channels in REQUIRED_ATTRIBUTES.items():
        actual = dict(header.attributes).get(name)
        if actual != channels:
            raise ValueError(
                f"required attribute {name!r} must have {channels} channels, got {actual}"
            )
    ovoxel_type_channels = dict(header.attributes).get(OPTIONAL_OVOXEL_TYPE_ATTRIBUTE)
    if ovoxel_type_channels not in (None, 1):
        raise ValueError(
            f"optional attribute {OPTIONAL_OVOXEL_TYPE_ATTRIBUTE!r} must have 1 channel, "
            f"got {ovoxel_type_channels}"
        )
    return header


def _decompress(data: bytes, algorithm: str, level: int | None) -> bytes:
    if algorithm == "none":
        return data
    if algorithm == "deflate":
        decompressor = zlib.decompressobj(wbits=-15)
        return decompressor.decompress(data) + decompressor.flush()
    if algorithm == "lzma":
        preset = 9 if level is None else level
        return lzma.decompress(
            data,
            format=lzma.FORMAT_RAW,
            filters=[{"id": lzma.FILTER_LZMA2, "preset": preset}],
        )
    if algorithm == "zstd":
        try:
            import zstandard
        except ImportError as exc:
            raise RuntimeError(
                "zstd-compressed VXZ needs the optional 'zstandard' package"
            ) from exc
        return zstandard.ZstdDecompressor().decompress(data)
    raise ValueError(f"unsupported VXZ compression algorithm: {algorithm!r}")


def _stream_bytes(
    binary: mmap.mmap,
    header: VxzHeader,
    chunk: dict[str, object],
    stream_name: str,
) -> bytes:
    try:
        chunk_pointer = chunk["ptr"]
        stream_pointer = chunk[stream_name]
        chunk_offset = int(chunk_pointer[0])  # type: ignore[index]
        stream_offset = int(stream_pointer[0])  # type: ignore[index]
        stream_length = int(stream_pointer[1])  # type: ignore[index]
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"invalid VXZ chunk pointer for {stream_name!r}: {exc}") from exc
    start = header.binary_start + chunk_offset + stream_offset
    end = start + stream_length
    if start < header.binary_start or end > len(binary):
        raise ValueError(f"VXZ stream {stream_name!r} points outside the file")
    return _decompress(binary[start:end], header.compression, header.compression_level)


def _decode_svo(svo: UINT8, voxel_count: int, depth: int) -> UINT32:
    """Decode the depth-first SVO byte stream into sorted Morton codes."""
    codes = np.empty(voxel_count, dtype=np.uint32)
    pointer = 0
    output_position = 0

    def visit(level: int, prefix: int) -> None:
        nonlocal pointer, output_position
        if pointer >= len(svo):
            raise ValueError("truncated sparse voxel octree")
        node = int(svo[pointer])
        pointer += 1
        if level == depth - 1:
            for child in range(8):
                if node & (1 << child):
                    if output_position >= voxel_count:
                        raise ValueError("sparse voxel octree has more leaves than attributes")
                    codes[output_position] = prefix | child
                    output_position += 1
            return

        shift = 3 * (depth - 1 - level)
        for child in range(8):
            if node & (1 << child):
                visit(level + 1, prefix | (child << shift))

    visit(0, 0)
    if pointer != len(svo):
        raise ValueError(f"sparse voxel octree has {len(svo) - pointer} trailing bytes")
    if output_position != voxel_count:
        raise ValueError(
            f"SVO/attribute count mismatch: decoded {output_position}, expected {voxel_count}"
        )
    return codes


def _extract_morton_bits(values: UINT32) -> UINT32:
    values = values & MORTON_MASK
    values = (values ^ (values >> np.uint32(2))) & np.uint32(0x030C30C3)
    values = (values ^ (values >> np.uint32(4))) & np.uint32(0x0300F00F)
    values = (values ^ (values >> np.uint32(8))) & np.uint32(0x030000FF)
    return (values ^ (values >> np.uint32(16))) & np.uint32(0x000003FF)


def _morton_to_coords(codes: UINT32, chunk_index: Sequence[int], chunk_size: int) -> INT32:
    coords = np.empty((len(codes), 3), dtype=np.int32)
    coords[:, 0] = _extract_morton_bits(codes >> np.uint32(2))
    coords[:, 1] = _extract_morton_bits(codes >> np.uint32(1))
    coords[:, 2] = _extract_morton_bits(codes)
    coords += np.asarray(chunk_index, dtype=np.int32) * chunk_size
    return coords


def _read_chunk_attributes(
    binary: mmap.mmap, header: VxzHeader, chunk: dict[str, object]
) -> dict[str, UINT8]:
    attributes: dict[str, UINT8] = {}
    if header.attr_interleave == "as_is":
        for name, channels in header.attributes:
            raw = _stream_bytes(binary, header, chunk, name)
            if len(raw) % channels:
                raise ValueError(f"attribute {name!r} byte count is not divisible by {channels}")
            attributes[name] = np.frombuffer(raw, dtype=np.uint8).reshape(-1, channels)
        return attributes

    if header.attr_interleave == "none":
        columns: list[UINT8] = []
        column_names: list[tuple[str, int]] = []
        for name, channels in header.attributes:
            for channel in range(channels):
                columns.append(
                    np.frombuffer(
                        _stream_bytes(binary, header, chunk, f"{name}_{channel}"),
                        dtype=np.uint8,
                    )
                )
                column_names.append((name, channel))
        if not columns or len({len(column) for column in columns}) != 1:
            raise ValueError("deinterleaved VXZ attribute columns have inconsistent lengths")
        for name, channels in header.attributes:
            attributes[name] = np.column_stack(
                [column for column, key in zip(columns, column_names) if key[0] == name]
            ).reshape(-1, channels)
        return attributes

    if header.attr_interleave == "all":
        total_channels = sum(channels for _, channels in header.attributes)
        raw = _stream_bytes(binary, header, chunk, "attr")
        if len(raw) % total_channels:
            raise ValueError("interleaved VXZ attribute byte count is inconsistent")
        all_attributes = np.frombuffer(raw, dtype=np.uint8).reshape(-1, total_channels)
        channel = 0
        for name, channels in header.attributes:
            attributes[name] = all_attributes[:, channel : channel + channels]
            channel += channels
        return attributes

    raise ValueError(f"unsupported attr_interleave mode: {header.attr_interleave!r}")


def read_vxz(source: Path) -> VxzData:
    started = time.perf_counter()
    with source.open("rb") as file:
        header = _parse_header(file, source)
        coords = np.empty((header.num_voxel, 3), dtype=np.int32)
        dual_vertices = np.empty((header.num_voxel, 3), dtype=np.uint8)
        intersected = np.empty(header.num_voxel, dtype=np.uint8)
        ovoxel_type = np.full(
            header.num_voxel, MISSING_OVOXEL_TYPE, dtype=np.uint8
        )
        has_ovoxel_type = OPTIONAL_OVOXEL_TYPE_ATTRIBUTE in dict(header.attributes)
        depth = header.chunk_size.bit_length() - 1
        write_position = 0

        with mmap.mmap(file.fileno(), length=0, access=mmap.ACCESS_READ) as binary:
            for chunk_number, chunk in enumerate(header.chunks, start=1):
                attributes = _read_chunk_attributes(binary, header, chunk)
                chunk_dual = attributes["dual_vertices"]
                chunk_intersected = attributes["intersected"]
                if chunk_dual.ndim != 2 or chunk_dual.shape[1] != 3:
                    raise ValueError(f"invalid dual_vertices shape in chunk {chunk_number}")
                if chunk_intersected.shape != (len(chunk_dual), 1):
                    raise ValueError(f"invalid intersected shape in chunk {chunk_number}")
                chunk_ovoxel_type = attributes.get(OPTIONAL_OVOXEL_TYPE_ATTRIBUTE)
                if has_ovoxel_type:
                    if chunk_ovoxel_type is None or chunk_ovoxel_type.shape != (
                        len(chunk_dual),
                        1,
                    ):
                        raise ValueError(
                            f"invalid {OPTIONAL_OVOXEL_TYPE_ATTRIBUTE} shape in chunk "
                            f"{chunk_number}"
                        )
                    if np.any(chunk_ovoxel_type > 3):
                        raise ValueError(
                            f"{OPTIONAL_OVOXEL_TYPE_ATTRIBUTE} values must be in [0, 3] "
                            f"in chunk {chunk_number}"
                        )

                svo = np.frombuffer(
                    _stream_bytes(binary, header, chunk, "svo"), dtype=np.uint8
                )
                codes = _decode_svo(svo, len(chunk_dual), depth)
                try:
                    chunk_index = chunk["idx"]
                    if len(chunk_index) != 3:  # type: ignore[arg-type]
                        raise ValueError
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError(f"invalid chunk index in chunk {chunk_number}") from exc
                chunk_coords = _morton_to_coords(
                    codes, chunk_index, header.chunk_size  # type: ignore[arg-type]
                )

                end = write_position + len(chunk_coords)
                if end > header.num_voxel:
                    raise ValueError("chunk voxel counts exceed the VXZ header count")
                coords[write_position:end] = chunk_coords
                dual_vertices[write_position:end] = chunk_dual
                intersected[write_position:end] = chunk_intersected[:, 0]
                if chunk_ovoxel_type is not None:
                    ovoxel_type[write_position:end] = chunk_ovoxel_type[:, 0]
                write_position = end

                if chunk_number == len(header.chunks) or chunk_number % 16 == 0:
                    print(
                        f"  read chunks {chunk_number}/{len(header.chunks)} "
                        f"({write_position:,}/{header.num_voxel:,} voxels)",
                        flush=True,
                    )

    if write_position != header.num_voxel:
        raise ValueError(
            f"chunk voxel counts total {write_position}, expected {header.num_voxel}"
        )
    print(f"  parsed VXZ in {time.perf_counter() - started:.1f}s", flush=True)
    return VxzData(coords, dual_vertices, intersected, ovoxel_type, header)


def _pack_coords(coords: INT32) -> UINT64:
    if np.any(coords < 0) or np.any(coords > int(PACKED_COORD_MASK)):
        raise ValueError("voxel coordinates must fit in unsigned 21-bit integers")
    values = coords.astype(np.uint64, copy=False)
    return (values[:, 0] << np.uint64(42)) | (values[:, 1] << MORTON_SHIFT) | values[:, 2]


def _candidate_batches(
    keys: UINT64,
    intersected: UINT8,
    sorted_keys: UINT64,
    sorted_to_original: NDArray[np.int64],
    batch_size: int,
) -> Iterator[INT32]:
    """Yield valid, orientation-correct four-voxel quads in source order."""
    voxel_count = len(keys)
    for start in range(0, voxel_count, batch_size):
        end = min(start + batch_size, voxel_count)
        flags = intersected[start:end]
        local_voxels, axes = np.nonzero(
            (flags[:, np.newaxis] & AXIS_PRESENCE_BITS[np.newaxis, :]) != 0
        )
        if not len(local_voxels):
            continue

        base_indices = local_voxels.astype(np.int64, copy=False) + start
        query_keys = keys[base_indices, np.newaxis] + EDGE_NEIGHBOR_KEY_OFFSETS[axes]
        positions = np.searchsorted(sorted_keys, query_keys.reshape(-1)).reshape(-1, 4)
        safe_positions = np.minimum(positions, voxel_count - 1)
        found = sorted_keys[safe_positions] == query_keys
        valid = (positions < voxel_count).all(axis=1) & found.all(axis=1)
        if not valid.any():
            continue

        base_indices = base_indices[valid]
        axes = axes[valid]
        positions = positions[valid]
        quads = sorted_to_original[positions].astype(np.int32, copy=False)
        reverse = (
            intersected[base_indices] & AXIS_POSITIVE_BITS[axes]
        ) != 0
        if reverse.any():
            quads[reverse] = quads[reverse][:, [0, 3, 2, 1]]
        yield quads


def _triangulate_quads(
    quads: INT32,
    coords: INT32,
    dual_vertices: UINT8,
    resolution: int,
) -> INT32:
    """Match the source decoder's float32 world-space split heuristic."""
    local_vertices = coords[quads].astype(np.float32)
    local_vertices += dual_vertices[quads].astype(np.float32) / np.float32(255.0)
    local_vertices *= np.float32(1.0 / resolution)
    local_vertices -= np.float32(0.5)
    v0, v1, v2, v3 = (local_vertices[:, index] for index in range(4))

    # Keep the source implementation's exact four-column normal comparison.
    normal_0a = np.cross(v1 - v0, v2 - v0)
    normal_0b = np.cross(v2 - v1, v0 - v1)
    align_0 = np.abs(np.einsum("ij,ij->i", normal_0a, normal_0b))
    normal_1a = np.cross(v1 - v0, v3 - v0)
    normal_1b = np.cross(v3 - v1, v3 - v1)
    align_1 = np.abs(np.einsum("ij,ij->i", normal_1a, normal_1b))
    split_1 = align_0 > align_1

    triangles = np.empty((len(quads) * 2, 3), dtype=np.int32)
    triangles[0::2] = quads[:, [0, 1, 3]]
    triangles[1::2] = quads[:, [3, 1, 2]]
    triangles[0::2][split_1] = quads[split_1][:, [0, 1, 2]]
    triangles[1::2][split_1] = quads[split_1][:, [0, 2, 3]]
    return triangles


def _write_ply_vertices(
    file: object,
    coords: INT32,
    dual_vertices: UINT8,
    resolution: int,
    batch_size: int,
) -> None:
    for start in range(0, len(coords), batch_size):
        end = min(start + batch_size, len(coords))
        vertices = coords[start:end].astype(np.float32)
        vertices += dual_vertices[start:end].astype(np.float32) / np.float32(255.0)
        vertices /= np.float32(resolution)
        vertices -= np.float32(0.5)
        vertices.astype("<f4", copy=False).tofile(file)  # type: ignore[arg-type]


def decode_vxz(source: Path, target: Path, resolution: int | None, batch_size: int) -> tuple[int, int]:
    data = read_vxz(source)
    inferred_resolution = int(data.coords.max()) + 1
    if resolution is None:
        resolution = inferred_resolution
        print(f"  inferred resolution: {resolution}", flush=True)
    if resolution <= int(data.coords.max()):
        raise ValueError(
            f"resolution {resolution} does not contain maximum voxel coordinate "
            f"{int(data.coords.max())}"
        )

    started = time.perf_counter()
    keys = _pack_coords(data.coords)
    sorted_to_original = np.argsort(keys, kind="stable")
    sorted_keys = keys[sorted_to_original]
    if len(sorted_keys) > 1 and np.any(sorted_keys[1:] == sorted_keys[:-1]):
        raise ValueError("VXZ contains duplicate voxel coordinates")
    print(f"  built CPU coordinate index in {time.perf_counter() - started:.1f}s", flush=True)

    started = time.perf_counter()
    quad_count = sum(
        len(quads)
        for quads in _candidate_batches(
            keys, data.intersected, sorted_keys, sorted_to_original, batch_size
        )
    )
    if quad_count == 0:
        raise ValueError("decoded mesh has no valid dual-grid quads")
    face_count = quad_count * 2
    print(
        f"  validated topology: {quad_count:,} quads / {face_count:,} faces "
        f"in {time.perf_counter() - started:.1f}s",
        flush=True,
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".{target.name}.{uuid.uuid4().hex}.tmp"
    try:
        started = time.perf_counter()
        with staged.open("wb") as output:
            header = (
                "ply\n"
                "format binary_little_endian 1.0\n"
                "comment CUDA-free O-Voxel Flexible Dual Grid decode\n"
                f"comment source {source.name}\n"
                f"comment resolution {resolution}\n"
                f"element vertex {len(data.coords)}\n"
                "property float x\n"
                "property float y\n"
                "property float z\n"
                f"element face {face_count}\n"
                "property list uchar int vertex_indices\n"
                "end_header\n"
            )
            output.write(header.encode("ascii"))
            _write_ply_vertices(output, data.coords, data.dual_vertices, resolution, batch_size)

            written_faces = 0
            for quads in _candidate_batches(
                keys, data.intersected, sorted_keys, sorted_to_original, batch_size
            ):
                triangles = _triangulate_quads(
                    quads,
                    data.coords,
                    data.dual_vertices,
                    resolution,
                )
                rows = np.empty(len(triangles), dtype=PLY_FACE_DTYPE)
                rows["vertex_count"] = 3
                rows["vertex_indices"] = triangles
                rows.tofile(output)
                written_faces += len(triangles)
            if written_faces != face_count:
                raise RuntimeError(
                    f"topology changed while writing: expected {face_count}, wrote {written_faces}"
                )
            output.flush()
            os.fsync(output.fileno())
        os.replace(staged, target)
        print(
            f"  wrote {target} ({target.stat().st_size / (1024 ** 2):.1f} MiB) "
            f"in {time.perf_counter() - started:.1f}s",
            flush=True,
        )
    finally:
        staged.unlink(missing_ok=True)
    return len(data.coords), face_count


def _collect_inputs(source_arg: Path, input_root: Path) -> list[InputItem]:
    source_arg = source_arg.expanduser()
    if source_arg.is_dir():
        sources = sorted(source_arg.rglob("*.vxz"))
        return [
            InputItem(source, source.relative_to(source_arg).with_suffix(".ply"))
            for source in sources
        ]
    if source_arg.is_file() and source_arg.suffix.lower() == ".vxz":
        return [InputItem(source_arg, Path(f"{source_arg.stem}.ply"))]
    if not source_arg.is_file():
        raise FileNotFoundError(source_arg)

    items: list[InputItem] = []
    seen_outputs: set[Path] = set()
    for line_number, line in enumerate(
        source_arg.read_text(encoding="utf-8").splitlines(), start=1
    ):
        value = line.partition("#")[0].strip()
        if not value:
            continue
        source = Path(value).expanduser()
        if not source.is_absolute():
            source = input_root / source
        if source.suffix.lower() != ".vxz":
            raise ValueError(
                f"{source_arg}:{line_number}: expected a .vxz path, got {value!r}"
            )
        relative_output = Path(f"{source.stem}.ply")
        if relative_output in seen_outputs:
            raise ValueError(
                f"duplicate VXZ stem would overwrite output: {relative_output.stem}"
            )
        seen_outputs.add(relative_output)
        items.append(InputItem(source, relative_output))
    return items


def _parse_resolution(value: str) -> int | None:
    if value.lower() == "auto":
        return None
    try:
        resolution = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("resolution must be 'auto' or a positive integer") from exc
    if resolution <= 0:
        raise argparse.ArgumentTypeError("resolution must be positive")
    return resolution


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source",
        type=Path,
        help="a VXZ file, a recursively searched directory, or a text file of VXZ paths",
    )
    parser.add_argument("output_dir", type=Path, help="directory for decoded binary PLY meshes")
    parser.add_argument(
        "--resolution",
        type=_parse_resolution,
        default=None,
        metavar="auto|N",
        help="voxel grid resolution (default: infer from the maximum coordinate)",
    )
    parser.add_argument(
        "--input-root",
        type=Path,
        default=Path.cwd(),
        help="base directory for relative paths in a text file (default: current directory)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_TOPOLOGY_BATCH_SIZE,
        help=f"voxel batch size for topology reconstruction (default: {DEFAULT_TOPOLOGY_BATCH_SIZE})",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="do not decode a VXZ when its output PLY already exists",
    )
    args = parser.parse_args()

    if args.batch_size <= 0:
        parser.error("--batch-size must be positive")
    try:
        inputs = _collect_inputs(args.source, args.input_root)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    if not inputs:
        parser.error(f"no .vxz files found under {args.source}")

    counts = {"decoded": 0, "skipped": 0, "failed": 0}
    for index, item in enumerate(inputs, start=1):
        target = args.output_dir / item.relative_output
        if args.skip_existing and target.is_file():
            counts["skipped"] += 1
            print(f"[{index}/{len(inputs)}] SKIP {target}", flush=True)
            continue
        print(f"[{index}/{len(inputs)}] {item.source} -> {target}", flush=True)
        try:
            if not item.source.is_file():
                raise FileNotFoundError(item.source)
            vertices, faces = decode_vxz(
                item.source, target, args.resolution, args.batch_size
            )
            counts["decoded"] += 1
            print(
                f"[{index}/{len(inputs)}] OK {vertices:,} vertices / {faces:,} faces",
                flush=True,
            )
        except Exception as exc:
            counts["failed"] += 1
            print(
                f"[{index}/{len(inputs)}] ERROR {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    print(
        f"done: total={len(inputs)} decoded={counts['decoded']} "
        f"skipped={counts['skipped']} failed={counts['failed']}"
    )
    return int(counts["failed"] > 0)


if __name__ == "__main__":
    raise SystemExit(main())
