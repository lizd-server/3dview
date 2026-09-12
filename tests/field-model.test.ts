import assert from "node:assert/strict";
import test from "node:test";

import {
  automaticContinuousRange,
  categoricalColorForValue,
  continuousColorForValue,
  fieldValueKey,
  grayscaleColorForAmount,
  isNoDataValue,
  stableLabelColor,
} from "../src/field-model.ts";

test("uses exact decimal keys for bigint labels", () => {
  const first = 9_007_199_254_740_992n;
  const second = 9_007_199_254_740_993n;
  assert.equal(fieldValueKey(first), "9007199254740992");
  assert.equal(fieldValueKey(second), "9007199254740993");
  assert.notEqual(fieldValueKey(first), fieldValueKey(second));
  assert.equal(fieldValueKey(2), fieldValueKey(2n));
});

test("assigns stable colors from exact bigint label IDs", () => {
  const first = 9_007_199_254_740_992n;
  const second = 9_007_199_254_740_993n;
  assert.equal(stableLabelColor(first), stableLabelColor(first));
  assert.notEqual(stableLabelColor(first), stableLabelColor(second));
});

test("matches no-data values by exact value key", () => {
  const validity = { noDataValues: ["-1", "9007199254740993"] };
  assert.equal(isNoDataValue(-1, validity), true);
  assert.equal(isNoDataValue(9_007_199_254_740_993n, validity), true);
  assert.equal(isNoDataValue(9_007_199_254_740_992n, validity), false);
});

test("automatic continuous ranges exclude declared no-data sentinels", () => {
  assert.deepEqual(
    automaticContinuousRange(new Float32Array([-9999, -2, 5]), { noDataValues: ["-9999"] }),
    [-2, 5],
  );
  assert.deepEqual(
    automaticContinuousRange(new Int32Array([-1, -1]), { noDataValues: ["-1"] }),
    [0, 1],
  );
  assert.deepEqual(
    automaticContinuousRange(new Int32Array([-1, 10, -1, 20, -1, 30]), { noDataValues: ["-1"] }, 3),
    [10, 30],
  );
});

test("grayscale colors remain parseable hex across the range", () => {
  assert.equal(grayscaleColorForAmount(0), "#000000");
  assert.equal(grayscaleColorForAmount(0.5), "#808080");
  assert.equal(grayscaleColorForAmount(1), "#ffffff");
});

test("uses an explicit schema color before the stable generated color", () => {
  assert.equal(categoricalColorForValue(7, { "7": { color: "#123456" } }), "#123456");
});

test("maps a continuous diverging style without interpolating categorical values", () => {
  const style = {
    range: [-0.1, 0.1] as const,
    center: 0,
    scale: "sqrt" as const,
    negativeColor: "#0d33f2",
    centerColor: "#ffffff",
    positiveColor: "#e60d0d",
    outOfRangeColor: "#000000",
  };
  assert.equal(continuousColorForValue(-0.1, style), "#0d33f2");
  assert.equal(continuousColorForValue(0, style), "#ffffff");
  assert.equal(continuousColorForValue(0.1, style), "#e60d0d");
  assert.equal(continuousColorForValue(0.1001, style), "#000000");
});
