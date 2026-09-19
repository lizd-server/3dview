#!/usr/bin/env python3
import json
import os
import sys

import numpy as np


def load_volume(path: str) -> np.ndarray:
    volume = np.load(path, mmap_mode="r", allow_pickle=False)
    if volume.ndim != 3:
        raise ValueError(f"expected a 3D NPY array, got shape {volume.shape}")
    if volume.dtype.kind not in "biuf":
        raise ValueError(f"unsupported NPY dtype {volume.dtype.str}")
    return volume


def metadata(path: str) -> None:
    volume = load_volume(path)
    print(json.dumps({
        "name": os.path.basename(path),
        "shape": list(volume.shape),
        "dtype": volume.dtype.str,
        "fortranOrder": bool(volume.flags.f_contiguous and not volume.flags.c_contiguous),
    }))


def slice_volume(path: str, axis_name: str, index_text: str) -> None:
    volume = load_volume(path)
    axes = {"x": 0, "y": 1, "z": 2}
    if axis_name not in axes:
        raise ValueError("axis must be x, y, or z")
    axis = axes[axis_name]
    index = int(index_text)
    if index < 0 or index >= volume.shape[axis]:
        raise ValueError(f"slice index {index} is outside axis size {volume.shape[axis]}")

    if axis_name == "x":
        image = volume[index, ::-1, :]
    elif axis_name == "y":
        image = volume[:, index, ::-1].T
    else:
        image = volume[:, ::-1, index].T

    payload = np.ascontiguousarray(image, dtype="<f4")
    sys.stdout.buffer.write(payload.tobytes(order="C"))


def main() -> None:
    if len(sys.argv) < 3:
        raise ValueError("usage: npy-slice.py metadata PATH | slice PATH AXIS INDEX")
    command = sys.argv[1]
    path = sys.argv[2]
    if command == "metadata" and len(sys.argv) == 3:
        metadata(path)
    elif command == "slice" and len(sys.argv) == 5:
        slice_volume(path, sys.argv[3], sys.argv[4])
    else:
        raise ValueError("invalid NPY slice command")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
