import {
  fieldValueKey,
  type FieldValue,
  type LabelDefinition,
} from "./field-model.ts";

/** Exact categorical identity, encoded with fieldValueKey. */
export type LabelKey = string;

export interface LabelFilterState {
  readonly query: string;
  readonly hiddenLabelKeys: ReadonlySet<LabelKey>;
  readonly isolatedLabelKey: LabelKey | null;
  readonly lockedHighlightKey: LabelKey | null;
}

export function createLabelFilterState(): LabelFilterState {
  return {
    query: "",
    hiddenLabelKeys: new Set(),
    isolatedLabelKey: null,
    lockedHighlightKey: null,
  };
}

export function labelKeyForValue(value: FieldValue): LabelKey {
  return fieldValueKey(value);
}

export function setLabelQuery(state: LabelFilterState, query: string): LabelFilterState {
  if (state.query === query) {
    return state;
  }
  return { ...state, query };
}

/** Match every whitespace-separated query term against ID, name, or group. */
export function labelMatchesQuery(
  query: string,
  key: LabelKey,
  definition?: Pick<LabelDefinition, "name" | "group">,
): boolean {
  const terms = normalizedQueryTerms(query);
  if (terms.length === 0) {
    return true;
  }
  const searchableValues = [key, definition?.name ?? "", definition?.group ?? ""]
    .map((value) => value.toLocaleLowerCase());
  return terms.every((term) => searchableValues.some((value) => value.includes(term)));
}

export function setLabelHidden(
  state: LabelFilterState,
  key: LabelKey,
  hidden: boolean,
): LabelFilterState {
  const isHidden = state.hiddenLabelKeys.has(key);
  if (hidden === isHidden) {
    return state;
  }

  const hiddenLabelKeys = new Set(state.hiddenLabelKeys);
  if (hidden) {
    hiddenLabelKeys.add(key);
  } else {
    hiddenLabelKeys.delete(key);
  }
  return { ...state, hiddenLabelKeys };
}

export function toggleLabelHidden(state: LabelFilterState, key: LabelKey): LabelFilterState {
  return setLabelHidden(state, key, !state.hiddenLabelKeys.has(key));
}

export function isolateLabel(state: LabelFilterState, key: LabelKey | null): LabelFilterState {
  if (state.isolatedLabelKey === key) {
    return state;
  }
  return { ...state, isolatedLabelKey: key };
}

export function lockLabelHighlight(
  state: LabelFilterState,
  key: LabelKey | null,
): LabelFilterState {
  if (state.lockedHighlightKey === key) {
    return state;
  }
  return { ...state, lockedHighlightKey: key };
}

export function isLabelHighlighted(state: LabelFilterState, key: LabelKey): boolean {
  return state.lockedHighlightKey === key;
}

/**
 * Decide whether a label is rendered. Isolation intentionally makes its target
 * visible even if that label was previously hidden; clearing isolation restores
 * the prior hidden-label state.
 */
export function isLabelVisible(
  state: LabelFilterState,
  key: LabelKey,
  definition?: Pick<LabelDefinition, "hidden">,
): boolean {
  if (state.isolatedLabelKey !== null) {
    return state.isolatedLabelKey === key;
  }
  return definition?.hidden !== true && !state.hiddenLabelKeys.has(key);
}

function normalizedQueryTerms(query: string): string[] {
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
