import assert from "node:assert/strict";
import test from "node:test";

import * as THREE from "three";

import { normalizeObjectToBounds } from "../src/mesh-normalization.ts";

test("normalizes a mesh uniformly to the current bounds size and center", () => {
  const object = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 8));
  object.position.set(3, -2, 5);
  const targetBounds = new THREE.Box3(
    new THREE.Vector3(9, 19, 29),
    new THREE.Vector3(11, 21, 31),
  );

  const normalized = normalizeObjectToBounds(object, targetBounds);

  assert.equal(normalized, true);
  const resultBounds = new THREE.Box3().setFromObject(object);
  assert.deepEqual(resultBounds.getCenter(new THREE.Vector3()).toArray(), [10, 20, 30]);
  assert.deepEqual(resultBounds.getSize(new THREE.Vector3()).toArray(), [1, 0.5, 2]);
});

test("keeps source coordinates when no current bounds are available", () => {
  const object = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
  object.position.set(7, 8, 9);

  const normalized = normalizeObjectToBounds(object, new THREE.Box3());

  assert.equal(normalized, false);
  assert.deepEqual(object.position.toArray(), [7, 8, 9]);
  assert.deepEqual(object.scale.toArray(), [1, 1, 1]);
});
