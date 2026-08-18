import assert from "node:assert/strict";
import test from "node:test";

import { vxzDataUrl } from "../src/vxz-data-url.ts";

test("versions immutable VXZ data URLs by binary format", () => {
  assert.equal(
    vxzDataUrl("http://127.0.0.1:5175/api/vxz", "job id", "voxels", 3),
    "http://127.0.0.1:5175/api/vxz/data?id=job%20id&kind=voxels&format=3",
  );
});
