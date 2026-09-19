import assert from "node:assert/strict";
import test from "node:test";

import {
  dataAxisForWorldAxis,
  manifestDisplayForValue,
  parseVolumeManifest,
  worldDimensionsForVolume,
  worldPositionForGrid,
  worldToDataGrid,
} from "../src/volume-manifest.ts";

const manifest = {
  defaults: {
    axisOrder: "zyx",
    association: "point",
    indexToWorld: [
      0.5, 0, 0, -1,
      0, 0.25, 0, -2,
      0, 0, 0.125, -3,
      0, 0, 0, 1,
    ],
  },
  fields: {
    "000_labels_before_flood.npy": {
      semantic: "categorical",
      categoricalPreset: "semantic",
      valueDescription: "Before flood",
      labels: {
        0: { name: "outside", color: "#2563eb", background: true, hidden: true },
        1: { name: "fixed inside", color: "#dc2626", group: "region" },
        2: { name: "unclassified core", color: "#eab308", group: "core" },
      },
    },
    "020_signed_distance.npy": {
      semantic: "continuous",
      validity: { noDataValues: ["NaN", -999], description: "not evaluated" },
      sparseDefault: "NaN",
      continuousStyle: {
        range: [-0.01, 0.01],
        center: 0,
        scale: "linear",
        negativeColor: "#0000ff",
        centerColor: "#ffffff",
        positiveColor: "#ff0000",
        outOfRangeColor: "#010203",
        isovalue: 0,
      },
    },
  },
};

test("parses categorical field styles and spatial defaults", () => {
  const metadata = parseVolumeManifest(manifest).get("000_labels_before_flood.npy");
  assert.ok(metadata);
  assert.equal(metadata.axisOrder, "zyx");
  assert.equal(metadata.association, "point");
  assert.equal(metadata.labels?.["2"].name, "unclassified core");
  assert.equal(metadata.labels?.["2"].color, "#eab308");
  assert.equal(metadata.labels?.["0"].hidden, true);
  assert.deepEqual(manifestDisplayForValue(metadata, 0), {
    color: [37, 99, 235], alpha: 0, noData: false, outOfRange: false,
  });
  assert.deepEqual(manifestDisplayForValue(metadata, 2), {
    color: [234, 179, 8], alpha: 255, noData: false, outOfRange: false,
  });
});

test("renders continuous fields from their declared range and colors", () => {
  const metadata = parseVolumeManifest(manifest).get("020_signed_distance.npy");
  assert.ok(metadata);
  assert.deepEqual(manifestDisplayForValue(metadata, -0.01)?.color, [0, 0, 255]);
  assert.deepEqual(manifestDisplayForValue(metadata, 0)?.color, [255, 255, 255]);
  assert.deepEqual(manifestDisplayForValue(metadata, 0.005)?.color, [255, 128, 128]);
  assert.deepEqual(manifestDisplayForValue(metadata, 0.02), {
    color: [1, 2, 3], alpha: 255, noData: false, outOfRange: true,
  });
  assert.equal(manifestDisplayForValue(metadata, Number.NaN)?.alpha, 0);
  assert.equal(manifestDisplayForValue(metadata, -999)?.noData, true);
});

test("maps permuted array axes and index-to-world coordinates", () => {
  const metadata = parseVolumeManifest(manifest).get("000_labels_before_flood.npy");
  assert.deepEqual(worldDimensionsForVolume([5, 7, 9], metadata), [9, 7, 5]);
  assert.deepEqual(worldToDataGrid([8, 6, 4], metadata), [4, 6, 8]);
  assert.equal(dataAxisForWorldAxis("x", metadata), 2);
  assert.equal(dataAxisForWorldAxis("z", metadata), 0);
  assert.deepEqual(worldPositionForGrid([2, 4, 6], [9, 7, 5], metadata), [0, -1, -2.25]);
});

test("supports legacy npy_labels string entries", () => {
  const metadata = parseVolumeManifest({
    files: {
      "999_linf_distance_cases.npy": {
        kind: "categorical",
        labels: { 4: "inside-only" },
      },
    },
  }).get("999_linf_distance_cases.npy");
  assert.equal(metadata?.labels?.["4"].name, "inside-only");
});

test("uses cell centers for manifests without an explicit transform", () => {
  const metadata = parseVolumeManifest({
    defaults: { association: "cell" },
    fields: { "field.npy": { semantic: "categorical" } },
  }).get("field.npy");
  assert.deepEqual(worldPositionForGrid([0, 1, 3], [4, 4, 4], metadata), [-0.75, -0.25, 0.75]);
});
