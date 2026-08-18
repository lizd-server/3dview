import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np

import decode_vxz
import vxz_worker


class OptionalOvoxelTypeTests(unittest.TestCase):
    def write_vxz(self, path: Path, ovoxel_type: np.ndarray | None) -> None:
        attributes = [["dual_vertices", 3], ["intersected", 1]]
        columns = [
            np.array(
                [
                    [10, 20, 30, 1],
                    [40, 50, 60, 0],
                    [70, 80, 90, 0],
                    [100, 110, 120, 0],
                ],
                dtype=np.uint8,
            )
        ]
        if ovoxel_type is not None:
            attributes.append(["ovoxel_type", 1])
            columns.append(ovoxel_type.reshape(-1, 1))
        rows = np.column_stack(columns).astype(np.uint8, copy=False)
        svo = bytes([0b00001111])
        binary = svo + rows.tobytes()
        structure = {
            "num_voxel": 4,
            "chunk_size": 2,
            "filter": "none",
            "compression": "none",
            "compression_level": None,
            "attr_interleave": "all",
            "attr": attributes,
            "chunks": [
                {
                    "idx": [0, 0, 0],
                    "ptr": [0, len(binary)],
                    "svo": [0, len(svo)],
                    "attr": [len(svo), rows.nbytes],
                }
            ],
        }
        raw_header = json.dumps(structure, separators=(",", ":")).encode("utf-8")
        path.write_bytes(
            b"VXZ" + bytes([0]) + struct.pack(">I", 8 + len(raw_header))
            + raw_header
            + binary
        )

    def test_reads_optional_ovoxel_type(self):
        expected = np.array([0, 1, 2, 3], dtype=np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "with-type.vxz"
            self.write_vxz(source, expected)
            np.testing.assert_array_equal(decode_vxz.read_vxz(source).ovoxel_type, expected)

    def test_old_vxz_uses_unavailable_sentinel(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "without-type.vxz"
            self.write_vxz(source, None)
            np.testing.assert_array_equal(
                decode_vxz.read_vxz(source).ovoxel_type,
                np.full(4, decode_vxz.MISSING_OVOXEL_TYPE, dtype=np.uint8),
            )

    def test_rejects_invalid_ovoxel_type(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "invalid-type.vxz"
            self.write_vxz(source, np.array([0, 1, 2, 4], dtype=np.uint8))
            with self.assertRaisesRegex(ValueError, "values must be in \\[0, 3\\]"):
                decode_vxz.read_vxz(source)

    def test_worker_cache_reports_fallback_case_counts(self):
        expected = np.array([0, 1, 2, 3], dtype=np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "with-type.vxz"
            self.write_vxz(source, expected)
            metadata = vxz_worker.prepare_cache(source, root / "cache")
            self.assertTrue(metadata["hasOvoxelType"])
            self.assertEqual(metadata["ovoxelTypeCounts"], [1, 1, 1, 1])
            np.testing.assert_array_equal(
                np.load(root / "cache" / "ovoxel_type.npy", allow_pickle=False),
                expected,
            )


class FlexibleDualGridTopologyTests(unittest.TestCase):
    def setUp(self):
        self.coords = np.array(
            [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
            dtype=np.int32,
        )
        self.keys = decode_vxz._pack_coords(self.coords)
        self.order = np.argsort(self.keys, kind="stable")
        self.sorted_keys = self.keys[self.order]

    def candidate_quad(self, flag: int) -> np.ndarray:
        flags = np.array([flag, 0, 0, 0], dtype=np.uint8)
        batches = list(
            decode_vxz._candidate_batches(
                self.keys,
                flags,
                self.sorted_keys,
                self.order,
                batch_size=4,
            )
        )
        self.assertEqual(len(batches), 1)
        return batches[0]

    def test_edge_presence_connects_the_four_neighbor_voxels(self):
        np.testing.assert_array_equal(
            self.candidate_quad(flag=1),
            np.array([[0, 1, 2, 3]], dtype=np.int32),
        )

    def test_positive_edge_sign_reverses_face_orientation(self):
        np.testing.assert_array_equal(
            self.candidate_quad(flag=1 | 8),
            np.array([[0, 3, 2, 1]], dtype=np.int32),
        )

    def test_quad_split_matches_trellis_decoder(self):
        triangles = decode_vxz._triangulate_quads(
            np.array([[0, 1, 2, 3]], dtype=np.int32),
            self.coords,
            np.zeros((4, 3), dtype=np.uint8),
            1,
        )
        np.testing.assert_array_equal(
            triangles,
            np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32),
        )

    def test_quad_split_uses_source_float32_world_space_order(self):
        coords = np.array(
            [[520, 354, 776], [520, 354, 777], [520, 355, 777], [520, 355, 776]],
            dtype=np.int32,
        )
        dual = np.array(
            [[225, 118, 135], [225, 246, 8], [225, 118, 135], [225, 127, 127]],
            dtype=np.uint8,
        )
        triangles = decode_vxz._triangulate_quads(
            np.array([[0, 1, 2, 3]], dtype=np.int32),
            coords,
            dual,
            1536,
        )
        np.testing.assert_array_equal(
            triangles,
            np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32),
        )


if __name__ == "__main__":
    unittest.main()
