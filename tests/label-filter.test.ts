import assert from "node:assert/strict";
import test from "node:test";

import { fieldValueKey } from "../src/field-model.ts";
import {
  createLabelFilterState,
  isLabelHighlighted,
  isLabelVisible,
  isolateLabel,
  labelKeyForValue,
  labelMatchesQuery,
  lockLabelHighlight,
  setLabelHidden,
  setLabelQuery,
  toggleLabelHidden,
} from "../src/label-filter.ts";

test("uses exact field value keys for large integer label identities", () => {
  const first = 9_007_199_254_740_993n;
  const second = 9_007_199_254_740_995n;
  const firstKey = labelKeyForValue(first);
  const secondKey = labelKeyForValue(second);

  assert.equal(firstKey, fieldValueKey(first));
  assert.equal(secondKey, fieldValueKey(second));
  assert.notEqual(firstKey, secondKey);

  const initial = createLabelFilterState();
  const hidden = setLabelHidden(initial, firstKey, true);
  assert.equal(hidden.hiddenLabelKeys.has(firstKey), true);
  assert.equal(hidden.hiddenLabelKeys.has(secondKey), false);
  assert.equal(initial.hiddenLabelKeys.size, 0);
});

test("matches case-insensitive query terms across label ID, name, and group", () => {
  const definition = { name: "Left Femur", group: "Lower Limb" };

  assert.equal(labelMatchesQuery("103", "103", definition), true);
  assert.equal(labelMatchesQuery("femur", "103", definition), true);
  assert.equal(labelMatchesQuery("LOWER", "103", definition), true);
  assert.equal(labelMatchesQuery("103 limb", "103", definition), true);
  assert.equal(labelMatchesQuery("right", "103", definition), false);
  assert.equal(labelMatchesQuery("   ", "103", definition), true);

  const queried = setLabelQuery(createLabelFilterState(), "femur");
  assert.equal(queried.query, "femur");
});

test("hidden labels are invisible and toggling does not mutate prior state", () => {
  const initial = createLabelFilterState();
  const hidden = toggleLabelHidden(initial, "7");

  assert.equal(isLabelVisible(initial, "7"), true);
  assert.equal(isLabelVisible(hidden, "7"), false);
  assert.equal(isLabelVisible(hidden, "8"), true);
  assert.equal(isLabelVisible(initial, "9", { hidden: true }), false);

  const shown = toggleLabelHidden(hidden, "7");
  assert.equal(isLabelVisible(shown, "7"), true);
  assert.equal(hidden.hiddenLabelKeys.has("7"), true);
});

test("isolation shows exactly one label and restores hidden state when cleared", () => {
  const hidden = setLabelHidden(createLabelFilterState(), "7", true);
  const isolated = isolateLabel(hidden, "7");

  assert.equal(isLabelVisible(isolated, "7"), true);
  assert.equal(isLabelVisible(isolated, "103"), false);

  const restored = isolateLabel(isolated, null);
  assert.equal(isLabelVisible(restored, "7"), false);
  assert.equal(isLabelVisible(restored, "103"), true);
});

test("locked highlight is exact and independent from visibility", () => {
  const hidden = setLabelHidden(createLabelFilterState(), "103", true);
  const locked = lockLabelHighlight(hidden, "103");

  assert.equal(isLabelHighlighted(locked, "103"), true);
  assert.equal(isLabelHighlighted(locked, "104"), false);
  assert.equal(isLabelVisible(locked, "103"), false);

  const cleared = lockLabelHighlight(locked, null);
  assert.equal(isLabelHighlighted(cleared, "103"), false);
  assert.equal(locked.lockedHighlightKey, "103");
});
