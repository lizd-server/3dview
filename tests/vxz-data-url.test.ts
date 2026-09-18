import assert from "node:assert/strict";
import test from "node:test";

import { vxzDataUrl } from "../src/vxz-data-url.ts";

test("versions VXZ data URLs by binary and cache format", () => {
  const url = (cache: number) => vxzDataUrl("/api/vxz", "job id", "mesh", 3, cache);
  assert.equal(url(5), "/api/vxz/data?id=job%20id&kind=mesh&format=3&cache=5");
  assert.notEqual(url(4), url(5));
});
