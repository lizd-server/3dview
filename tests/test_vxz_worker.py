import struct
import unittest

import numpy as np

import vxz_worker


class SliceGridMappingTests(unittest.TestCase):
    def test_pixel_to_grid_matches_cell_contract(self):
        resolution = 8
        self.assertEqual(
            vxz_worker.slice_pixel_to_grid("x", 3, 5, 2, resolution),
            (3, 5, 5),
        )
        self.assertEqual(
            vxz_worker.slice_pixel_to_grid("y", 3, 5, 2, resolution),
            (5, 3, 5),
        )
        self.assertEqual(
            vxz_worker.slice_pixel_to_grid("z", 3, 5, 2, resolution),
            (5, 5, 3),
        )

    def test_grid_pixel_round_trip_for_every_axis(self):
        resolution = 8
        coords = (2, 5, 6)
        for axis, index in (("x", 2), ("y", 5), ("z", 6)):
            pixel = vxz_worker.grid_to_slice_pixel(axis, coords, resolution)
            self.assertEqual(
                vxz_worker.slice_pixel_to_grid(axis, index, *pixel, resolution),
                coords,
            )

    def test_voxel_center_is_cell_centered(self):
        np.testing.assert_allclose(
            vxz_worker.voxel_world_centers(
                np.array([[0, 0, 0], [7, 7, 7]], dtype=np.int32), 8
            ),
            np.array([[-0.4375] * 3, [0.4375] * 3], dtype=np.float32),
        )

    def test_explicit_resolution_preserves_empty_boundary_cells(self):
        coords = np.array([[2, 3, 4], [7, 6, 5]], dtype=np.int32)
        self.assertEqual(vxz_worker.resolve_grid_resolution(coords, None), (8, "inferred"))
        self.assertEqual(vxz_worker.resolve_grid_resolution(coords, 16), (16, "explicit"))
        with self.assertRaisesRegex(ValueError, "does not contain"):
            vxz_worker.resolve_grid_resolution(coords, 7)


class BinaryContractTests(unittest.TestCase):
    def setUp(self):
        self.coords = np.array([[1, 2, 3], [4, 5, 6]], dtype=np.int32)
        self.dual = np.array([[10, 20, 30], [40, 50, 60]], dtype=np.uint8)
        self.flags = np.array([9, 18], dtype=np.uint8)
        self.ovoxel_type = np.array([0, 3], dtype=np.uint8)

    def test_voxel_preview_header_and_records(self):
        payload = vxz_worker.build_voxel_payload(
            self.coords, self.dual, self.flags, self.ovoxel_type, resolution=8
        )
        magic, version, count, resolution = struct.unpack_from("<4sIII", payload)
        self.assertEqual((magic, version, count, resolution), (b"VXVP", 2, 2, 8))
        records = np.frombuffer(payload, dtype=vxz_worker.VOXEL_RECORD_DTYPE, offset=16)
        np.testing.assert_array_equal(records["coords"], self.coords)
        np.testing.assert_array_equal(records["dual"], self.dual)
        np.testing.assert_array_equal(records["intersected"], self.flags)
        np.testing.assert_array_equal(records["ovoxel_type"], self.ovoxel_type)

    def test_slice_payload_contains_only_matching_cells(self):
        payload = vxz_worker.build_slice_payload(
            self.coords,
            self.dual,
            self.flags,
            self.ovoxel_type,
            resolution=8,
            axis="z",
            index=3,
        )
        magic, version, count, resolution, axis_index, slice_index = struct.unpack_from(
            "<4sIIIII", payload
        )
        self.assertEqual(
            (magic, version, count, resolution, axis_index, slice_index),
            (b"VXSL", 2, 1, 8, 2, 3),
        )
        records = np.frombuffer(payload, dtype=vxz_worker.VOXEL_RECORD_DTYPE, offset=24)
        np.testing.assert_array_equal(records["coords"], self.coords[:1])
        np.testing.assert_array_equal(records["dual"], self.dual[:1])
        np.testing.assert_array_equal(records["intersected"], self.flags[:1])
        np.testing.assert_array_equal(records["ovoxel_type"], self.ovoxel_type[:1])

    def test_mesh_payload_uses_float_positions_and_uint_indices(self):
        positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype=np.float32)
        indices = np.array([0, 1, 2], dtype=np.uint32)
        payload = vxz_worker.build_mesh_payload(positions, indices)
        magic, version, vertex_count, index_count = struct.unpack_from("<4sIII", payload)
        self.assertEqual((magic, version, vertex_count, index_count), (b"VXMP", 2, 3, 3))
        decoded_positions = np.frombuffer(payload, "<f4", 9, 16).reshape(-1, 3)
        decoded_indices = np.frombuffer(payload, "<u4", 3, 16 + positions.nbytes)
        np.testing.assert_array_equal(decoded_positions, positions)
        np.testing.assert_array_equal(decoded_indices, indices)

    def test_voxel_payload_rejects_misaligned_ovoxel_type(self):
        with self.assertRaisesRegex(ValueError, "ovoxel_type must have shape"):
            vxz_worker.build_voxel_payload(
                self.coords,
                self.dual,
                self.flags,
                self.ovoxel_type[:1],
                resolution=8,
            )


class ClusteredMeshPreviewTests(unittest.TestCase):
    def test_dual_vertex_at_cell_boundary_joins_the_next_cluster(self):
        coords = np.array([[1, 0, 0], [2, 0, 0]], dtype=np.int32)
        dual = np.array([[255, 0, 0], [0, 0, 0]], dtype=np.uint8)
        positions, vertex_clusters = vxz_worker._cluster_vertex_map(
            coords, dual, resolution=8, cluster_width=2
        )
        self.assertEqual(len(positions), 1)
        np.testing.assert_array_equal(vertex_clusters, [0, 0])

    def test_duplicate_clustered_faces_are_removed_without_losing_winding(self):
        triangles = np.array(
            [[0, 1, 2], [2, 1, 0], [0, 2, 3]], dtype=np.int32
        )
        np.testing.assert_array_equal(
            vxz_worker._deduplicate_triangles(triangles),
            np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32),
        )


if __name__ == "__main__":
    unittest.main()
