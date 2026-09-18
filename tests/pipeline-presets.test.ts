import assert from "node:assert/strict";
import test from "node:test";

import {
  applicablePipelineVisualization,
  classifyPipelineValue,
  inferPipelinePreset,
  pipelineColorForValue,
} from "../src/pipeline-presets.ts";

test("uses legacy colors only while resolved semantics match the preset", () => {
  assert.equal(
    applicablePipelineVisualization("999_scalar_field.npy", "continuous", "semantic"),
    "scalarField",
  );
  assert.equal(
    applicablePipelineVisualization("999_scalar_field.npy", "categorical", "semantic"),
    undefined,
  );
  assert.equal(
    applicablePipelineVisualization("004_final_labels.npy", "categorical", "semantic"),
    "pipelineLabels",
  );
  assert.equal(
    applicablePipelineVisualization("004_final_labels.npy", "categorical", "instances"),
    undefined,
  );
});

test("recognizes every legacy pipeline filename family without claiming arbitrary names", () => {
  const cases: Array<[string, string, number]> = [
    ["000_initial_ccl_labels.npy", "pipelineLabels", 0],
    ["012_final_ccl_labels.npy", "pipelineLabels", 12],
    ["013_inside_filtered_labels.npy", "pipelineLabels", 13],
    ["002_free_space_labels.npy", "pipelineLabels", 2],
    ["004_final_labels.npy", "pipelineLabels", 4],
    ["000_original_boundary.npy", "boundaryMask", 0],
    ["001_closed_boundary.npy", "boundaryMask", 1],
    ["012_final_ccl_components.npy", "finalCclComponents", 12.1],
    ["003_pseudo_boundary_components.npy", "componentLabels", 3],
    ["012_final_ccl_cases.npy", "finalCclCases", 12.2],
    ["014_surface_boundary_classification.npy", "surfaceBoundaryClassification", 14],
    ["999_scalar_field.npy", "scalarField", 999],
    ["999_linf_distance_cases.npy", "linfinityDistanceCases", 999.1],
  ];
  for (const [name, id, order] of cases) {
    const preset = inferPipelinePreset(name);
    assert.equal(preset?.id, id, name);
    assert.equal(preset?.order, order, name);
    assert.equal(preset?.metadata.coordinatePreset, "normalized", name);
    assert.equal(preset?.metadata.association, "point", name);
  }
  assert.equal(inferPipelinePreset("researcher_output.npy"), null);
  assert.deepEqual(inferPipelinePreset("012_final_ccl_cases.npy")?.group, {
    prefix: "012",
    role: "cases",
  });
  assert.deepEqual(inferPipelinePreset("013_inside_filtered_labels.npy")?.group, {
    prefix: "012",
    role: "insideFiltered",
  });
  assert.deepEqual(inferPipelinePreset("014_surface_boundary_classification.npy")?.group, {
    prefix: "012",
    role: "surfaceBoundary",
  });
});

test("preserves legacy pipeline label classification and fixed colors", () => {
  assert.equal(classifyPipelineValue(0, "pipelineLabels"), "unknown");
  assert.equal(classifyPipelineValue(3, "pipelineLabels"), "band");
  assert.equal(classifyPipelineValue(4, "pipelineLabels"), "surface");
  assert.equal(classifyPipelineValue(17, "finalCclComponents"), "components");
  assert.equal(classifyPipelineValue(6, "finalCclCases"), "bothSides");
  assert.equal(classifyPipelineValue(4, "surfaceBoundaryClassification"), "surfaceBoundaryOutside");
  assert.deepEqual(pipelineColorForValue(1, "pipelineLabels"), [37, 99, 235]);
  assert.deepEqual(pipelineColorForValue(2, "pipelineLabels"), [220, 38, 38]);
  assert.deepEqual(pipelineColorForValue(3, "pipelineLabels"), [250, 204, 21]);
  assert.equal(classifyPipelineValue(4.75, "finalCclComponents"), null);
});

test("preserves scalar-field endpoint colors and exact bigint component identity", () => {
  assert.deepEqual(pipelineColorForValue(-0.1, "scalarField"), [13, 51, 242]);
  assert.deepEqual(pipelineColorForValue(0, "scalarField"), [255, 255, 255]);
  assert.deepEqual(pipelineColorForValue(0.1, "scalarField"), [230, 13, 13]);
  assert.notDeepEqual(
    pipelineColorForValue(9_007_199_254_740_992n, "componentLabels"),
    pipelineColorForValue(9_007_199_254_740_993n, "componentLabels"),
  );
});
