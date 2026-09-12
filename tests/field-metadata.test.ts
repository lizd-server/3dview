import assert from "node:assert/strict";
import test from "node:test";

import { fieldValueKey, isNoDataValue, type NpyArray3D } from "../src/field-model.ts";
import {
  fieldMetadataFor,
  parseFieldManifest,
  resolveFieldDefinition,
} from "../src/field-metadata.ts";
import { transformIndexToWorld } from "../src/grid-field.ts";
import { inferPipelinePreset } from "../src/pipeline-presets.ts";

test("parses fields.json defaults and per-file metadata with exact label properties", () => {
  const manifest = parseFieldManifest(JSON.stringify({
    version: 1,
    defaults: {
      semantic: "continuous",
      association: "cell",
      axisOrder: "zyx",
      coordinatePreset: "index",
      validity: { noDataValues: [-1, "9007199254740993"], description: "producer mask" },
      sparseDefault: "0",
      labels: { "0": { name: "empty", background: true, hidden: true } },
    },
    fields: {
      "labels.npy": {
        semantic: "categorical",
        categoricalPreset: "instances",
        labels: { "7": { name: "handle", color: "#ABCDEF", group: "parts" } },
      },
    },
  }), "fields.json");

  assert.deepEqual(manifest.warnings, []);
  assert.equal(manifest.format, "fields");
  const resolved = resolveFieldDefinition(npyArray("labels.npy", "<i4", [2, 3, 4]), { manifest });
  assert.equal(resolved.semantic, "categorical");
  assert.equal(resolved.semanticSource, "metadata");
  assert.equal(resolved.categoricalPreset, "instances");
  assert.equal(resolved.association, "cell");
  assert.deepEqual(resolved.sourceAxisOrder, ["z", "y", "x"]);
  assert.deepEqual(resolved.logicalShape, [4, 3, 2]);
  assert.deepEqual(resolved.labels["0"], { name: "empty", background: true, hidden: true });
  assert.deepEqual(resolved.labels["7"], { name: "handle", color: "#abcdef", group: "parts" });
  assert.deepEqual(resolved.validity, {
    noDataValues: ["-1", "9007199254740993"],
    description: "producer mask",
  });
  assert.equal(resolved.sparseDefault, "0");
  assert.deepEqual(transformIndexToWorld([0, 0, 0], resolved.indexToWorld), [0.5, 0.5, 0.5]);
});

test("applies user, metadata, preset, then dtype semantic precedence", () => {
  const array = npyArray("004_final_labels.npy", "<i4", [2, 2, 2]);
  const preset = inferPipelinePreset(array.name);
  const manifest = parseFieldManifest(JSON.stringify({
    defaults: { semantic: "continuous" },
    fields: { "004_final_labels.npy": { association: "cell" } },
  }));

  const metadataResolved = resolveFieldDefinition(array, { preset, manifest });
  assert.equal(metadataResolved.semantic, "continuous");
  assert.equal(metadataResolved.semanticSource, "metadata");
  assert.equal(metadataResolved.coordinateSource, "preset");

  const userResolved = resolveFieldDefinition(array, {
    preset,
    manifest,
    userOverrides: { semantic: "categorical", coordinatePreset: "index" },
  });
  assert.equal(userResolved.semantic, "categorical");
  assert.equal(userResolved.semanticSource, "user");
  assert.equal(userResolved.coordinateSource, "user");

  const inferred = resolveFieldDefinition(npyArray("plain.npy", "<f4", [2, 2, 2]));
  assert.equal(inferred.semantic, "continuous");
  assert.equal(inferred.semanticSource, "dtype");
  assert.equal(inferred.coordinateSource, "index");
});

test("changing a categorical preset drops incompatible legacy labels but keeps explicit schema", () => {
  const array = npyArray("004_final_labels.npy", "<i4", [2, 2, 2]);
  const preset = inferPipelinePreset(array.name);
  const manifest = parseFieldManifest(JSON.stringify({
    fields: { "004_final_labels.npy": { labels: { "9": { name: "custom instance", color: "#123456" } } } },
  }));
  const resolved = resolveFieldDefinition(array, {
    preset,
    manifest,
    userOverrides: { categoricalPreset: "instances" },
  });

  assert.equal(resolved.labels["1"], undefined);
  assert.deepEqual(resolved.labels["9"], { name: "custom instance", color: "#123456" });
  assert.equal(resolved.stylePreset, undefined);
});

test("changing a scalar preset to categorical drops its continuous display style", () => {
  const array = npyArray("999_scalar_field.npy", "<f4", [2, 2, 2]);
  const resolved = resolveFieldDefinition(array, {
    preset: inferPipelinePreset(array.name),
    userOverrides: { semantic: "categorical" },
  });

  assert.deepEqual(resolved.continuousStyle, {});
  assert.equal(resolved.stylePreset, undefined);
});

test("partial continuous overrides preserve independent metadata style properties", () => {
  const array = npyArray("custom.npy", "<f4", [2, 2, 2]);
  const manifest = parseFieldManifest(JSON.stringify({
    fields: {
      "custom.npy": {
        continuousStyle: {
          center: 0,
          isovalue: 0.5,
          scale: "sqrt",
          negativeColor: "#112233",
          centerColor: "#445566",
          positiveColor: "#778899",
        },
      },
    },
  }));
  const resolved = resolveFieldDefinition(array, {
    manifest,
    userOverrides: { continuousStyle: { range: [-2, 3], isovalue: 0.75 } },
  });

  assert.deepEqual(resolved.continuousStyle, {
    center: 0,
    isovalue: 0.75,
    scale: "sqrt",
    negativeColor: "#112233",
    centerColor: "#445566",
    positiveColor: "#778899",
    range: [-2, 3],
  });
});

test("a per-file coordinate preset overrides a default explicit transform", () => {
  const manifest = parseFieldManifest(JSON.stringify({
    defaults: {
      indexToWorld: [
        2, 0, 0, 10,
        0, 2, 0, 20,
        0, 0, 2, 30,
        0, 0, 0, 1,
      ],
    },
    fields: { "field.npy": { coordinatePreset: "index", association: "point" } },
  }));
  const resolved = resolveFieldDefinition(npyArray("field.npy", "<u1", [2, 2, 2]), { manifest });
  assert.deepEqual(transformIndexToWorld([1, 1, 1], resolved.indexToWorld), [1, 1, 1]);
});

test("an explicit null continuous range clears an inherited preset range", () => {
  const array = npyArray("999_scalar_field.npy", "<f4", [2, 2, 2]);
  const preset = inferPipelinePreset(array.name);
  const manifest = parseFieldManifest(JSON.stringify({
    fields: { "999_scalar_field.npy": { continuousStyle: { range: null } } },
  }));
  const resolved = resolveFieldDefinition(array, { preset, manifest });

  assert.equal(resolved.continuousStyle.range, null);
  assert.deepEqual(manifest.warnings, []);
});

test("accepts legacy npy_labels.json and converts labels and isovalue", () => {
  const manifest = parseFieldManifest(JSON.stringify({
    files: {
      "nested/999_scalar_field.npy": {
        kind: "signed scalar field",
        labels: { "0": "zero" },
        dynamic_labels: { "7": "special" },
        value_description: "signed distance",
        isovalue: 0.25,
      },
    },
  }), "npy_labels.json");
  const metadata = fieldMetadataFor(manifest, "999_scalar_field.npy");

  assert.equal(manifest.format, "legacy");
  assert.equal(metadata?.semantic, "continuous");
  assert.deepEqual(metadata?.labels, { "0": { name: "zero" }, "7": { name: "special" } });
  assert.equal(metadata?.continuousStyle?.isovalue, 0.25);
  assert.equal(metadata?.valueDescription, "signed distance");
});

test("returns actionable warnings for invalid JSON and invalid metadata", () => {
  const invalidJson = parseFieldManifest("{", "fields.json");
  assert.match(invalidJson.warnings[0], /invalid JSON/);

  const invalidMetadata = parseFieldManifest(JSON.stringify({
    fields: { "bad.npy": { semantic: "integer", axisOrder: "xxx", indexToWorld: [1, 2] } },
  }));
  assert.ok(invalidMetadata.warnings.some((warning) => warning.includes("semantic")));
  assert.ok(invalidMetadata.warnings.some((warning) => warning.includes("sourceAxisOrder")));
  assert.ok(invalidMetadata.warnings.some((warning) => warning.includes("indexToWorld")));
});

test("requires quoted strings for integer metadata IDs outside the safe range", () => {
  const manifest = parseFieldManifest(JSON.stringify({
    fields: {
      "ids.npy": {
        validity: { noDataValues: [9_007_199_254_740_992] },
        sparseDefault: 9_007_199_254_740_992,
      },
    },
  }));
  const metadata = fieldMetadataFor(manifest, "ids.npy");

  assert.ok(manifest.warnings.some((warning) => warning.includes("must be quoted strings")));
  assert.deepEqual(metadata?.validity?.noDataValues, []);
  assert.equal(metadata?.sparseDefault, undefined);
});

test("normalizes numeric metadata keys to the field's stored float precision", () => {
  const array = npyArray("float-labels.npy", "<f4", [2, 2, 2]);
  const manifest = parseFieldManifest(JSON.stringify({
    fields: {
      "float-labels.npy": {
        validity: { noDataValues: [0.1] },
        sparseDefault: 0.1,
        labels: { "0.1": { name: "sentinel" } },
      },
    },
  }));
  const resolved = resolveFieldDefinition(array, { manifest });
  const storedValue = Math.fround(0.1);
  const storedKey = fieldValueKey(storedValue);

  assert.equal(isNoDataValue(storedValue, resolved.validity), true);
  assert.deepEqual(resolved.validity.noDataValues, [storedKey]);
  assert.equal(resolved.sparseDefault, storedKey);
  assert.deepEqual(resolved.labels[storedKey], { name: "sentinel" });
});

function npyArray(name: string, dtype: string, sourceShape: [number, number, number]): NpyArray3D {
  return {
    name,
    sourceShape,
    data: dtype.includes("f")
      ? new Float32Array(sourceShape[0] * sourceShape[1] * sourceShape[2])
      : new Int32Array(sourceShape[0] * sourceShape[1] * sourceShape[2]),
    dtype,
    fortranOrder: false,
    warnings: [],
  };
}
