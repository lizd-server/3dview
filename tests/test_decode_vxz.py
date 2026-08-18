import unittest

import numpy as np

import decode_vxz


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
        )
        np.testing.assert_array_equal(
            triangles,
            np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32),
        )


if __name__ == "__main__":
    unittest.main()
