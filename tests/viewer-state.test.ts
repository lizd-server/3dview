import assert from "node:assert/strict";
import test from "node:test";

import {
  activeSliceIndex,
  clearPinnedPoint,
  createViewerState,
  pinGridPoint,
  reconcileViewerState,
  setActiveAxis,
  setSliceIndex,
} from "../src/viewer-state.ts";

test("pinning a point links all three slice indices without mutating prior state", () => {
  const initial = createViewerState([8, 9, 10]);
  const pinned = pinGridPoint(initial, [2, 3, 4], [8, 9, 10]);

  assert.deepEqual(pinned.pinnedGridPoint, [2, 3, 4]);
  assert.deepEqual(pinned.sliceIndices, { x: 2, y: 3, z: 4 });
  assert.equal(initial.pinnedGridPoint, null);
  assert.deepEqual(initial.sliceIndices, { x: 3, y: 4, z: 4 });
});

test("changing axes preserves the linked XYZ point and uses each axis index", () => {
  const pinned = pinGridPoint(createViewerState([8, 9, 10]), [2, 3, 4], [8, 9, 10]);
  const xActive = setActiveAxis(pinned, "x");
  const yActive = setActiveAxis(xActive, "y");
  const zActive = setActiveAxis(yActive, "z");

  assert.equal(activeSliceIndex(xActive), 2);
  assert.equal(activeSliceIndex(yActive), 3);
  assert.equal(activeSliceIndex(zActive), 4);
  assert.deepEqual(zActive.pinnedGridPoint, [2, 3, 4]);
  assert.deepEqual(zActive.sliceIndices, { x: 2, y: 3, z: 4 });
});

test("clearing a pin keeps the linked slices at their last inspected point", () => {
  const pinned = pinGridPoint(createViewerState([8, 9, 10]), [5, 6, 7], [8, 9, 10]);
  const cleared = clearPinnedPoint(pinned);

  assert.equal(cleared.pinnedGridPoint, null);
  assert.deepEqual(cleared.sliceIndices, { x: 5, y: 6, z: 7 });
  assert.deepEqual(pinned.pinnedGridPoint, [5, 6, 7]);
});

test("non-cubic shapes clamp pinning, slice movement, and shape reconciliation per axis", () => {
  const shape = [2, 5, 9] as const;
  const pinned = pinGridPoint(createViewerState(shape), [-3, 99, 5.6], shape);

  assert.deepEqual(pinned.pinnedGridPoint, [0, 4, 6]);
  assert.deepEqual(pinned.sliceIndices, { x: 0, y: 4, z: 6 });

  const moved = setSliceIndex(pinned, "z", 99, shape);
  assert.deepEqual(moved.pinnedGridPoint, [0, 4, 8]);
  assert.deepEqual(moved.sliceIndices, { x: 0, y: 4, z: 8 });

  const reconciled = reconcileViewerState(moved, [1, 3, 4]);
  assert.deepEqual(reconciled.pinnedGridPoint, [0, 2, 3]);
  assert.deepEqual(reconciled.sliceIndices, { x: 0, y: 2, z: 3 });
});
