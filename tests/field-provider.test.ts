import assert from "node:assert/strict";
import test from "node:test";

import {
  type DenseField,
  type NpyNumericArray,
  type ResolvedFieldDefinition,
  type SourceAxisOrder,
} from "../src/field-model.ts";
import { InMemoryFieldProvider } from "../src/field-provider.ts";

const LOGICAL_SHAPE: [number, number, number] = [2, 3, 4];

test("reads an exact point and all three canonical slices from a C-order XYZ field", async () => {
  const provider = new InMemoryFieldProvider(createNumberField(false, ["x", "y", "z"]));

  assert.deepEqual(await provider.readPoint([1, 2, 3]), {
    index: [1, 2, 3],
    world: [1, 2, 3],
    value: 123,
    fidelity: "exact",
  });

  const xSlice = await provider.readSlice({ axis: "x", index: 1 });
  assert.deepEqual(xSlice.planeAxes, ["z", "y"]);
  assert.deepEqual(xSlice.shape, [4, 3]);
  assert.ok(xSlice.values instanceof Int32Array);
  assert.deepEqual(Array.from(xSlice.values), [
    100, 101, 102, 103,
    110, 111, 112, 113,
    120, 121, 122, 123,
  ]);
  assert.equal(xSlice.fidelity, "exact");

  const ySlice = await provider.readSlice({ axis: "y", index: 1 });
  assert.deepEqual(ySlice.planeAxes, ["x", "z"]);
  assert.deepEqual(ySlice.shape, [2, 4]);
  assert.deepEqual(Array.from(ySlice.values), [
    10, 110,
    11, 111,
    12, 112,
    13, 113,
  ]);

  const zSlice = await provider.readSlice({ axis: "z", index: 2 });
  assert.deepEqual(zSlice.planeAxes, ["x", "y"]);
  assert.deepEqual(zSlice.shape, [2, 3]);
  assert.deepEqual(Array.from(zSlice.values), [
    2, 102,
    12, 112,
    22, 122,
  ]);
});

test("keeps logical XYZ coordinates across source order and storage layout", async () => {
  const cases: Array<[boolean, SourceAxisOrder]> = [
    [false, ["z", "y", "x"]],
    [true, ["x", "y", "z"]],
    [true, ["z", "y", "x"]],
  ];
  for (const [fortranOrder, sourceAxisOrder] of cases) {
    const provider = new InMemoryFieldProvider(createNumberField(fortranOrder, sourceAxisOrder));
    assert.equal((await provider.readPoint([1, 2, 3])).value, 123);
    assert.deepEqual(
      Array.from((await provider.readSlice({ axis: "x", index: 1 })).values),
      [100, 101, 102, 103, 110, 111, 112, 113, 120, 121, 122, 123],
    );
    assert.deepEqual(
      Array.from((await provider.readSlice({ axis: "y", index: 1 })).values),
      [10, 110, 11, 111, 12, 112, 13, 113],
    );
    assert.deepEqual(
      Array.from((await provider.readSlice({ axis: "z", index: 2 })).values),
      [2, 102, 12, 112, 22, 122],
    );
  }
});

test("preserves uint64 labels beyond JavaScript's safe integer range", async () => {
  const labels = new BigUint64Array([
    9_007_199_254_740_993n,
    18_446_744_073_709_551_615n,
    9_007_199_254_740_995n,
    9_007_199_254_740_997n,
  ]);
  const field = createDenseField(labels, [2, 1, 2], ["x", "y", "z"], false, "<u8");
  const provider = new InMemoryFieldProvider(field);

  assert.equal((await provider.readPoint([0, 0, 1])).value, 18_446_744_073_709_551_615n);
  const slice = await provider.readSlice({ axis: "y", index: 0 });
  assert.ok(slice.values instanceof BigUint64Array);
  assert.deepEqual(Array.from(slice.values), [
    9_007_199_254_740_993n,
    9_007_199_254_740_995n,
    18_446_744_073_709_551_615n,
    9_007_199_254_740_997n,
  ]);
});

test("rejects point and slice indices outside the logical grid", async () => {
  const provider = new InMemoryFieldProvider(createNumberField(false, ["x", "y", "z"]));

  await assert.rejects(provider.readPoint([-1, 0, 0]), RangeError);
  await assert.rejects(provider.readPoint([0, 3, 0]), RangeError);
  await assert.rejects(provider.readSlice({ axis: "x", index: 2 }), RangeError);
  await assert.rejects(provider.readSlice({ axis: "z", index: 4 }), RangeError);
});

test("rejects point and slice reads when their signal is already aborted", async () => {
  const provider = new InMemoryFieldProvider(createNumberField(false, ["x", "y", "z"]));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    provider.readPoint([0, 0, 0], controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  await assert.rejects(
    provider.readSlice({ axis: "z", index: 0 }, controller.signal),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});

function createNumberField(fortranOrder: boolean, sourceAxisOrder: SourceAxisOrder): DenseField {
  const sourceShape = sourceAxisOrder.map((axis) => LOGICAL_SHAPE[axisIndex(axis)]) as [number, number, number];
  const values = new Int32Array(LOGICAL_SHAPE[0] * LOGICAL_SHAPE[1] * LOGICAL_SHAPE[2]);

  for (let x = 0; x < LOGICAL_SHAPE[0]; x += 1) {
    for (let y = 0; y < LOGICAL_SHAPE[1]; y += 1) {
      for (let z = 0; z < LOGICAL_SHAPE[2]; z += 1) {
        const logical = [x, y, z] as const;
        const sourceIndex = sourceAxisOrder.map((axis) => logical[axisIndex(axis)]);
        const offset = fortranOrder
          ? sourceIndex[0] + sourceShape[0] * (sourceIndex[1] + sourceShape[1] * sourceIndex[2])
          : sourceIndex[2] + sourceShape[2] * (sourceIndex[1] + sourceShape[1] * sourceIndex[0]);
        values[offset] = 100 * x + 10 * y + z;
      }
    }
  }

  return createDenseField(values, sourceShape, sourceAxisOrder, fortranOrder, "<i4");
}

function createDenseField(
  data: NpyNumericArray,
  sourceShape: [number, number, number],
  sourceAxisOrder: SourceAxisOrder,
  fortranOrder: boolean,
  dtype: string,
): DenseField {
  const logicalShape: [number, number, number] = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    logicalShape[axisIndex(sourceAxisOrder[sourceAxis])] = sourceShape[sourceAxis];
  }
  return {
    array: {
      name: "field.npy",
      sourceShape,
      data,
      dtype,
      fortranOrder,
      warnings: [],
    },
    definition: createDefinition(sourceAxisOrder, logicalShape),
  };
}

function createDefinition(
  sourceAxisOrder: SourceAxisOrder,
  logicalShape: [number, number, number],
): ResolvedFieldDefinition {
  return {
    name: "field.npy",
    semantic: "categorical",
    semanticSource: "user",
    categoricalPreset: "semantic",
    association: "point",
    sourceAxisOrder,
    logicalShape,
    indexToWorld: [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ],
    coordinateSource: "index",
    coordinatePreset: "index",
    labels: {},
    continuousStyle: {},
  };
}

function axisIndex(axis: "x" | "y" | "z"): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}
