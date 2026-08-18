import assert from "node:assert/strict";
import test from "node:test";

import { projectVxzDualVertexToSlice } from "../src/vxz-dual-slice-projection.ts";

function assertClose(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("projects a dual vertex to its sub-cell position on a Z slice", () => {
  const projection = projectVxzDualVertexToSlice(
    "z",
    [1, 2, 3],
    [128, 64, 255],
    4,
  );

  assertClose(projection.pixel[0], 1.5019607843137255);
  assertClose(projection.pixel[1], 1.7490196078431373);
  assertClose(projection.plane[0], -0.24901960784313726);
  assertClose(projection.plane[1], 0.12549019607843137);
});

test("uses Z horizontally and Y vertically on an X slice", () => {
  const projection = projectVxzDualVertexToSlice("x", [1, 2, 0], [51, 102, 153], 4);

  assertClose(projection.pixel[0], 0.6);
  assertClose(projection.pixel[1], 1.6);
  assertClose(projection.plane[0], -0.7);
  assertClose(projection.plane[1], 0.2);
});

test("uses X horizontally and Z vertically on a Y slice", () => {
  const projection = projectVxzDualVertexToSlice("y", [1, 2, 0], [51, 102, 153], 4);

  assertClose(projection.pixel[0], 1.2);
  assertClose(projection.pixel[1], 3.4);
  assertClose(projection.plane[0], -0.4);
  assertClose(projection.plane[1], -0.7);
});
