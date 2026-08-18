import assert from "node:assert/strict";
import test from "node:test";

import {
  vxzQefRankColor,
  vxzQefRankDeficient,
  vxzQefRankDescription,
} from "../src/vxz-qef-rank.ts";

test("classifies QEF ranks before regularization", () => {
  assert.equal(vxzQefRankDeficient(0), true);
  assert.equal(vxzQefRankDeficient(2), true);
  assert.equal(vxzQefRankDeficient(3), false);
  assert.equal(vxzQefRankDeficient(255), null);
});

test("gives every stored QEF rank a distinct diagnostic color", () => {
  const colors = [0, 1, 2, 3].map((rank) => vxzQefRankColor(rank).join(","));
  assert.equal(new Set(colors).size, 4);
  assert.equal(vxzQefRankColor(255).join(","), "100,116,139");
});

test("describes full rank, rank deficiency, and unavailable data", () => {
  assert.equal(vxzQefRankDescription(2), "2 · rank deficient");
  assert.equal(vxzQefRankDescription(3), "3 · full rank");
  assert.equal(vxzQefRankDescription(255), "Unavailable");
});
