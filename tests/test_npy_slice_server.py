import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "server" / "npy-slice.py"


class NpySliceServerTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "volume.npy"
        self.volume = np.fromfunction(
            lambda x, y, z: x * 100 + y * 10 + z,
            (2, 3, 4),
            dtype=np.float32,
        ).astype(np.float32)
        np.save(self.path, self.volume)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_script(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            check=True,
            capture_output=True,
        ).stdout

    def test_metadata_does_not_load_the_full_volume(self):
        payload = json.loads(self.run_script("metadata", str(self.path)))
        self.assertEqual(payload["shape"], [2, 3, 4])
        self.assertEqual(payload["dtype"], "<f4")

    def test_slice_orientation_matches_the_viewer_pixel_mapping(self):
        cases = {
            "x": self.volume[1, ::-1, :],
            "y": self.volume[:, 1, ::-1].T,
            "z": self.volume[:, ::-1, 2].T,
        }
        for axis, expected in cases.items():
            index = {"x": 1, "y": 1, "z": 2}[axis]
            payload = self.run_script("slice", str(self.path), axis, str(index))
            actual = np.frombuffer(payload, dtype="<f4").reshape(expected.shape)
            np.testing.assert_array_equal(actual, expected)


if __name__ == "__main__":
    unittest.main()
