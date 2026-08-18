import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import vxzApiModule from "../server/vxz-api.cjs";

const { createVxzApi } = vxzApiModule;

test("all read routes reject an old on-disk VXZ cache after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "vxz-old-cache-"));
  const id = "a".repeat(64);
  const jobDir = path.join(root, id);
  await mkdir(jobDir);
  await writeFile(path.join(jobDir, "metadata.json"), JSON.stringify({
    formatVersion: 2,
    cacheVersion: 4,
    sourceName: "old.vxz",
    resolution: 8,
  }));
  for (const name of [
    "coords.npy",
    "dual.npy",
    "intersected.npy",
    "ovoxel_type.npy",
    "voxels.bin",
    "mesh.bin",
  ]) {
    await writeFile(path.join(jobDir, name), "old");
  }

  const api = createVxzApi({
    cacheRoot: root,
    projectRoot: path.resolve("."),
    python: "/usr/bin/false",
  });
  const server = createServer((request, response) => {
    api.handle(request, response, new URL(request.url ?? "/", "http://127.0.0.1"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/vxz`;

  try {
    for (const suffix of [
      `/status?id=${id}`,
      `/data?id=${id}&kind=voxels`,
      `/slice?id=${id}&axis=z&index=0`,
    ]) {
      const response = await fetch(`${base}${suffix}`);
      assert.equal(response.status, 404, suffix);
    }
  } finally {
    api.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
