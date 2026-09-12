export type FieldSemantic = "categorical" | "continuous";

export type SemanticSource = "user" | "metadata" | "preset" | "dtype";

export type CategoricalDisplayPreset = "semantic" | "instances";

export type GridAssociation = "point" | "cell";

export type LogicalAxis = "x" | "y" | "z";

/**
 * The logical axis represented by each source-array dimension.
 *
 * For example, ["z", "y", "x"] means source shape [Z, Y, X].
 */
export type SourceAxisOrder = readonly [LogicalAxis, LogicalAxis, LogicalAxis];

export type Shape3 = readonly [number, number, number];
export type Index3 = readonly [number, number, number];
export type WorldPoint3 = readonly [number, number, number];

/** Row-major affine matrix applied to a logical [x, y, z, 1] sample index. */
export type Matrix4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export type CoordinatePreset = "index" | "normalized";
export type CoordinateSource = "user" | "metadata" | "preset" | "index";

export type FieldValue = number | bigint;

export type NpyNumericArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | BigInt64Array
  | BigUint64Array
  | Float32Array
  | Float64Array;

export interface NpyArray3D {
  name: string;
  sourceShape: [number, number, number];
  data: NpyNumericArray;
  dtype: string;
  fortranOrder: boolean;
  warnings: string[];
}

export interface LabelDefinition {
  name?: string;
  color?: string;
  group?: string;
  background?: boolean;
  hidden?: boolean;
}

export type LabelSchema = Record<string, LabelDefinition>;

export type ContinuousScale = "linear" | "sqrt";

export interface ContinuousStyle {
  /** A null range explicitly requests automatic range calculation. */
  range?: readonly [number, number] | null;
  center?: number;
  scale?: ContinuousScale;
  negativeColor?: string;
  centerColor?: string;
  positiveColor?: string;
  outOfRangeColor?: string;
  isovalue?: number;
}

/** Exact value keys which distinguish missing data from ordinary field values. */
export interface FieldValidity {
  noDataValues?: readonly string[];
  description?: string;
}

/** A partial field description supplied by a preset, manifest, or UI override. */
export interface FieldMetadataPatch {
  semantic?: FieldSemantic;
  categoricalPreset?: CategoricalDisplayPreset;
  association?: GridAssociation;
  sourceAxisOrder?: SourceAxisOrder;
  coordinatePreset?: CoordinatePreset;
  indexToWorld?: Matrix4;
  labels?: LabelSchema;
  continuousStyle?: ContinuousStyle;
  validity?: FieldValidity;
  sparseDefault?: string;
  valueDescription?: string;
  stylePreset?: string;
}

export interface ResolvedFieldDefinition {
  name: string;
  semantic: FieldSemantic;
  semanticSource: SemanticSource;
  categoricalPreset: CategoricalDisplayPreset;
  association: GridAssociation;
  sourceAxisOrder: SourceAxisOrder;
  logicalShape: [number, number, number];
  indexToWorld: Matrix4;
  coordinateSource: CoordinateSource;
  coordinatePreset?: CoordinatePreset;
  labels: LabelSchema;
  continuousStyle: ContinuousStyle;
  validity: FieldValidity;
  sparseDefault?: string;
  valueDescription?: string;
  stylePreset?: string;
  presetId?: string;
}

export interface DenseField {
  array: NpyArray3D;
  definition: ResolvedFieldDefinition;
}

export const IDENTITY_INDEX_TO_WORLD: Matrix4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

export function fieldValueKey(value: FieldValue): string {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "Infinity";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "-Infinity";
  }
  return Object.is(value, -0) ? "0" : String(value);
}

export function isNoDataValue(value: FieldValue, validity: FieldValidity): boolean {
  return validity.noDataValues?.includes(fieldValueKey(value)) ?? false;
}

/** Computes an approximate display range while excluding declared no-data samples. */
export function automaticContinuousRange(
  values: NpyNumericArray,
  validity: FieldValidity,
  maximumSamples = 1_000_000,
): [number, number] {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  const sampleLimit = Number.isFinite(maximumSamples)
    ? Math.max(1, Math.floor(maximumSamples))
    : 1_000_000;
  const sampleCount = Math.min(values.length, sampleLimit);
  const includeValueAt = (index: number): void => {
    const value = values[index];
    if (isNoDataValue(value, validity)) {
      return;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      minimum = Math.min(minimum, numeric);
      maximum = Math.max(maximum, numeric);
    }
  };
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    // Sample the midpoint of each equal-width bin. This avoids locking onto
    // one phase of a periodic validity mask while retaining global coverage.
    includeValueAt(Math.min(
      values.length - 1,
      Math.floor((sampleIndex + 0.5) * values.length / sampleCount),
    ));
  }
  if (!Number.isFinite(minimum) && sampleCount < values.length) {
    // Try a second phase before concluding that a sampled field has no valid
    // values. This protects common interleaved masks without scanning all data.
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      includeValueAt(Math.floor(sampleIndex * values.length / sampleCount));
    }
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return [0, 1];
  }
  if (minimum === maximum) {
    const padding = Math.max(Math.abs(minimum) * 0.01, 0.5);
    return [minimum - padding, maximum + padding];
  }
  return [minimum, maximum];
}

export function grayscaleColorForAmount(amount: number): string {
  const shade = Math.round(Math.max(0, Math.min(1, amount)) * 255);
  const channel = shade.toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

export function formatFieldValue(value: FieldValue): string {
  return fieldValueKey(value);
}

/** Stable categorical color which hashes the exact label key, including uint64 IDs. */
export function stableLabelColor(value: FieldValue): string {
  const key = fieldValueKey(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = (hash >>> 0) % 360;
  return hslToHex(hue / 360, 0.68, 0.57);
}

export function labelDefinitionForValue(
  value: FieldValue,
  labels: LabelSchema,
): LabelDefinition | undefined {
  return labels[fieldValueKey(value)];
}

export function categoricalColorForValue(value: FieldValue, labels: LabelSchema): string {
  return labelDefinitionForValue(value, labels)?.color ?? stableLabelColor(value);
}

export function continuousColorForValue(value: FieldValue, style: ContinuousStyle): string {
  const outsideColor = style.outOfRangeColor ?? "#000000";
  if (typeof value === "bigint" || !Number.isFinite(value)) {
    return outsideColor;
  }
  const range = style.range ?? [0, 1];
  const center = style.center ?? (range[0] + range[1]) / 2;
  if (value < range[0] || value > range[1]) {
    return outsideColor;
  }
  const isPositive = value >= center;
  const span = isPositive ? range[1] - center : center - range[0];
  const linearStrength = span > 0 ? Math.abs(value - center) / span : 0;
  const strength = style.scale === "sqrt" ? Math.sqrt(linearStrength) : linearStrength;
  return interpolateHexColor(
    style.centerColor ?? "#ffffff",
    isPositive ? style.positiveColor ?? "#e60d0d" : style.negativeColor ?? "#0d33f2",
    Math.max(0, Math.min(1, strength)),
  );
}

function interpolateHexColor(from: string, to: string, amount: number): string {
  const fromChannels = hexChannels(from);
  const toChannels = hexChannels(to);
  const channels = fromChannels.map((channel, index) => (
    Math.round(channel + (toChannels[index] - channel) * amount)
  ));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function hexChannels(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) {
    throw new Error(`Expected a six-digit hex color, got ${color}.`);
  }
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

function hslToHex(h: number, s: number, l: number): string {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channels = s === 0
    ? [l, l, l]
    : [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
  return `#${channels
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hueToRgb(p: number, q: number, input: number): number {
  let t = input;
  if (t < 0) {
    t += 1;
  }
  if (t > 1) {
    t -= 1;
  }
  if (t < 1 / 6) {
    return p + (q - p) * 6 * t;
  }
  if (t < 1 / 2) {
    return q;
  }
  if (t < 2 / 3) {
    return p + (q - p) * (2 / 3 - t) * 6;
  }
  return p;
}
