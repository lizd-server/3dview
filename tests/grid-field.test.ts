import assert from "node:assert/strict";
import test from "node:test";

import {
  computeTransformedSlicePlaneFrame,
  formatIndexToWorldText,
  createPresetIndexToWorld,
  parseIndexToWorldText,
  sliceCoordinatesToLogicalIndex,
  slicePixelToLogicalIndex,
  transformIndexToWorld,
} from "../src/grid-field.ts";

test("custom matrix text round-trips without locale grouping or precision loss", () => {
  const matrix = [
    1000, 0, 0, -0.000000123456789,
    0, 2.5, 0, 20,
    0, 0, 3, 30,
    0, 0, 0, 1,
  ] as const;
  const formatted = formatIndexToWorldText(matrix);

  assert.equal(formatted.includes("1,000"), false);
  assert.deepEqual(parseIndexToWorldText(formatted), matrix);
});

test("keeps provider slice coordinates separate from canvas row inversion", () => {
  const shape: [number, number, number] = [4, 3, 2];
  assert.deepEqual(sliceCoordinatesToLogicalIndex(shape, "x", 2, 1, 0), [2, 0, 1]);
  assert.deepEqual(slicePixelToLogicalIndex(shape, "x", 2, 1, 0), [2, 2, 1]);
  assert.deepEqual(sliceCoordinatesToLogicalIndex(shape, "y", 1, 3, 1), [3, 1, 1]);
  assert.deepEqual(sliceCoordinatesToLogicalIndex(shape, "z", 0, 3, 2), [3, 2, 0]);
});

test("normalizes point samples to grid nodes and cell samples to cell centers", () => {
  const pointMatrix = createPresetIndexToWorld("normalized", [5, 5, 5], "point");
  const cellMatrix = createPresetIndexToWorld("normalized", [5, 5, 5], "cell");

  assert.deepEqual(transformIndexToWorld([0, 0, 0], pointMatrix), [-1, -1, -1]);
  assert.deepEqual(transformIndexToWorld([4, 4, 4], pointMatrix), [1, 1, 1]);
  assert.deepEqual(transformIndexToWorld([0, 0, 0], cellMatrix), [-0.8, -0.8, -0.8]);
  assert.deepEqual(transformIndexToWorld([4, 4, 4], cellMatrix), [0.8, 0.8, 0.8]);
});

test("index coordinate preset identifies cell centers without normalizing them", () => {
  const matrix = createPresetIndexToWorld("index", [10, 20, 30], "cell");
  assert.deepEqual(transformIndexToWorld([0, 2, 4], matrix), [0.5, 2.5, 4.5]);
});

test("applies explicit indexToWorld matrices in row-major order", () => {
  const matrix = [
    2, 0, 0, 10,
    0, 3, 0, 20,
    0, 0, 4, 30,
    0, 0, 0, 1,
  ] as const;
  assert.deepEqual(transformIndexToWorld([1, 2, 3], matrix), [12, 26, 42]);
});

test("preserves affine slice axes and negative-axis normal orientation", () => {
  const matrix = [
    2, 0.5, 0.2, 10,
    0, 3, 0.4, 20,
    0.1, 0.2, 4, 30,
    0, 0, 0, 1,
  ] as const;

  const frame = computeTransformedSlicePlaneFrame([5, 3, 7], "point", matrix, "x", 2);

  assertVectorClose(frame.center, transformIndexToWorld([2, 1, 3], matrix));
  assertVectorClose(frame.basisU, [0.6, 1.2, 12]);
  assertVectorClose(frame.basisV, [0.5, 3, 0.2]);
  assert.ok(dot(frame.normal, [2, 0, 0.1]) < 0);
  assert.ok(Math.abs(length(frame.normal) - 1) < 1e-12);
});

test("gives a normalized point singleton axis a finite one-sample footprint", () => {
  const matrix = createPresetIndexToWorld("normalized", [5, 1, 7], "point");
  const frame = computeTransformedSlicePlaneFrame([5, 1, 7], "point", matrix, "x", 2);

  assertFiniteFrame(frame);
  assert.ok(length(frame.basisU) > 0);
  assert.ok(length(frame.basisV) > 0);
  assert.ok(length(cross(frame.basisU, frame.basisV)) > 0);
  assert.ok(dot(frame.normal, [1, 0, 0]) < 0);
});

test("keeps a slice frame non-degenerate when both in-plane point dimensions are singletons", () => {
  const matrix = createPresetIndexToWorld("normalized", [5, 1, 1], "point");
  const frame = computeTransformedSlicePlaneFrame([5, 1, 1], "point", matrix, "x", 2);

  assertFiniteFrame(frame);
  assert.ok(length(frame.basisU) > 0);
  assert.ok(length(frame.basisV) > 0);
  assert.ok(length(cross(frame.basisU, frame.basisV)) > 0);
  assert.ok(dot(frame.normal, [1, 0, 0]) < 0);
});

test("uses half an affine sample step for a point singleton footprint", () => {
  const matrix = [
    2, 0, 1, 4,
    1, 4, 0, 5,
    0, 2, 3, 6,
    0, 0, 0, 1,
  ] as const;
  const frame = computeTransformedSlicePlaneFrame([3, 1, 4], "point", matrix, "x", 1);

  assertVectorClose(frame.basisV, [0, 2, 1]);
  assertFiniteFrame(frame);
  assert.ok(dot(frame.normal, [2, 1, 0]) < 0);
});

test("handles an entirely singleton normalized point grid for every slice axis", () => {
  const matrix = createPresetIndexToWorld("normalized", [1, 1, 1], "point");
  for (const axis of ["x", "y", "z"] as const) {
    const frame = computeTransformedSlicePlaneFrame([1, 1, 1], "point", matrix, axis, 0);
    assertFiniteFrame(frame);
    assert.ok(length(frame.basisU) > 0);
    assert.ok(length(frame.basisV) > 0);
    assert.ok(length(cross(frame.basisU, frame.basisV)) > 0);
    const expectedNegativeAxis = axis === "x" ? [-1, 0, 0] : axis === "y" ? [0, -1, 0] : [0, 0, -1];
    assert.ok(dot(frame.normal, expectedNegativeAxis) > 0);
  }
});

function assertFiniteFrame(frame: ReturnType<typeof computeTransformedSlicePlaneFrame>): void {
  for (const vector of [frame.center, frame.basisU, frame.basisV, frame.normal]) {
    assert.ok(vector.every(Number.isFinite));
  }
  assert.ok(Math.abs(length(frame.normal) - 1) < 1e-12);
}

function assertVectorClose(actual: readonly number[], expected: readonly number[], tolerance = 1e-12): void {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) <= tolerance, `${actual} != ${expected}`);
  }
}

function length(vector: readonly number[]): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(first: readonly number[], second: readonly number[]): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function cross(first: readonly number[], second: readonly number[]): [number, number, number] {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}
