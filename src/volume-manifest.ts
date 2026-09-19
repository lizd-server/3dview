import type {
  VolumeContinuousStyle,
  VolumeLabelDefinition,
  VolumeLabelMetadata,
  VolumeValidity,
} from "./types";

type JsonRecord = Record<string, unknown>;

export interface ManifestValueDisplay {
  color: [number, number, number] | null;
  alpha: number;
  noData: boolean;
  outOfRange: boolean;
}

export function parseVolumeManifest(value: unknown): Map<string, VolumeLabelMetadata> {
  if (!isRecord(value)) {
    throw new Error("Volume manifest must be a JSON object.");
  }

  const defaults = isRecord(value.defaults) ? value.defaults : {};
  const spatialDefaults = {
    axisOrder: parseAxisOrder(defaults.axisOrder),
    association: stringValue(defaults.association),
    indexToWorld: numberArray(defaults.indexToWorld, 16),
  };
  const result = new Map<string, VolumeLabelMetadata>();

  if (isRecord(value.files)) {
    for (const [name, rawMetadata] of Object.entries(value.files)) {
      if (!isRecord(rawMetadata)) {
        continue;
      }
      result.set(baseFileName(name), {
        ...spatialDefaults,
        kind: stringValue(rawMetadata.kind),
        labels: labelDefinitions(rawMetadata.labels),
        dynamicLabels: labelDefinitions(rawMetadata.dynamic_labels),
        valueDescription: stringValue(rawMetadata.value_description),
        isovalue: finiteNumber(rawMetadata.isovalue),
      });
    }
  }

  if (isRecord(value.fields)) {
    for (const [name, rawMetadata] of Object.entries(value.fields)) {
      if (!isRecord(rawMetadata)) {
        continue;
      }
      const continuousStyle = parseContinuousStyle(rawMetadata.continuousStyle);
      result.set(baseFileName(name), {
        ...spatialDefaults,
        kind: stringValue(rawMetadata.semantic),
        categoricalPreset: stringValue(rawMetadata.categoricalPreset),
        labels: labelDefinitions(rawMetadata.labels),
        valueDescription: stringValue(rawMetadata.valueDescription),
        isovalue: continuousStyle?.isovalue,
        validity: parseValidity(rawMetadata.validity),
        sparseDefault: scalarValue(rawMetadata.sparseDefault),
        continuousStyle,
      });
    }
  }

  return result;
}

export function manifestDisplayForValue(
  metadata: VolumeLabelMetadata | undefined,
  value: number,
): ManifestValueDisplay | null {
  if (!metadata) {
    return null;
  }

  if (isNoDataValue(value, metadata)) {
    return { color: [0, 0, 0], alpha: 0, noData: true, outOfRange: false };
  }

  if (metadata.kind === "continuous" && metadata.continuousStyle) {
    return continuousDisplay(value, metadata.continuousStyle);
  }

  const definition = metadata.labels?.[String(Math.trunc(value))];
  if (!definition) {
    return null;
  }
  return {
    color: parseHexColor(definition.color),
    alpha: definition.hidden ? 0 : 255,
    noData: false,
    outOfRange: false,
  };
}

export function labelDefinitionForValue(
  metadata: VolumeLabelMetadata | undefined,
  value: number,
): VolumeLabelDefinition | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const key = String(Math.trunc(value));
  return metadata?.labels?.[key] ?? metadata?.dynamicLabels?.[key];
}

export function volumeAxisOrder(metadata: VolumeLabelMetadata | undefined): string {
  return parseAxisOrder(metadata?.axisOrder) ?? "xyz";
}

export function worldDimensionsForVolume(
  shape: [number, number, number],
  metadata: VolumeLabelMetadata | undefined,
): [number, number, number] {
  const order = volumeAxisOrder(metadata);
  const dimensions: [number, number, number] = [1, 1, 1];
  for (let dataAxis = 0; dataAxis < 3; dataAxis += 1) {
    dimensions[axisIndex(order[dataAxis])] = shape[dataAxis];
  }
  return dimensions;
}

export function worldToDataGrid(
  worldGrid: [number, number, number],
  metadata: VolumeLabelMetadata | undefined,
): [number, number, number] {
  const order = volumeAxisOrder(metadata);
  return [
    worldGrid[axisIndex(order[0])],
    worldGrid[axisIndex(order[1])],
    worldGrid[axisIndex(order[2])],
  ];
}

export function dataAxisForWorldAxis(
  worldAxis: "x" | "y" | "z",
  metadata: VolumeLabelMetadata | undefined,
): 0 | 1 | 2 {
  return volumeAxisOrder(metadata).indexOf(worldAxis) as 0 | 1 | 2;
}

export function worldPositionForGrid(
  grid: [number, number, number],
  dimensions: [number, number, number],
  metadata: VolumeLabelMetadata | undefined,
): [number, number, number] {
  const matrix = metadata?.indexToWorld;
  if (matrix?.length === 16) {
    const [x, y, z] = grid;
    const w = matrix[12] * x + matrix[13] * y + matrix[14] * z + matrix[15];
    const divisor = w === 0 ? 1 : w;
    return [
      (matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3]) / divisor,
      (matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7]) / divisor,
      (matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11]) / divisor,
    ];
  }
  return [
    defaultIndexToWorld(grid[0], dimensions[0], metadata?.association),
    defaultIndexToWorld(grid[1], dimensions[1], metadata?.association),
    defaultIndexToWorld(grid[2], dimensions[2], metadata?.association),
  ];
}

export function parseHexColor(value: string | undefined): [number, number, number] | null {
  if (!value) {
    return null;
  }
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const hex = match[1].length === 3
    ? match[1].split("").map((part) => part + part).join("")
    : match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function continuousDisplay(value: number, style: VolumeContinuousStyle): ManifestValueDisplay {
  const range = style.range ?? [-0.1, 0.1];
  const lower = Math.min(range[0], range[1]);
  const upper = Math.max(range[0], range[1]);
  const center = Number.isFinite(style.center) ? style.center as number : 0;
  const outOfRangeColor = parseHexColor(style.outOfRangeColor) ?? [0, 0, 0];
  if (value < lower || value > upper) {
    return { color: outOfRangeColor, alpha: 255, noData: false, outOfRange: true };
  }

  const centerColor = parseHexColor(style.centerColor) ?? [255, 255, 255];
  const endpoint = value < center
    ? parseHexColor(style.negativeColor) ?? [37, 99, 235]
    : parseHexColor(style.positiveColor) ?? [220, 38, 38];
  const denominator = value < center ? center - lower : upper - center;
  let amount = denominator > 0 ? Math.abs(value - center) / denominator : 0;
  amount = Math.max(0, Math.min(1, amount));
  if (style.scale === "sqrt") {
    amount = Math.sqrt(amount);
  }
  return {
    color: interpolateColor(centerColor, endpoint, amount),
    alpha: 255,
    noData: false,
    outOfRange: false,
  };
}

function isNoDataValue(value: number, metadata: VolumeLabelMetadata): boolean {
  if (!Number.isFinite(value)) {
    return true;
  }
  if (typeof metadata.sparseDefault === "number" && value === metadata.sparseDefault) {
    return true;
  }
  return (metadata.validity?.noDataValues ?? []).some((candidate) => (
    typeof candidate === "number" && value === candidate
  ));
}

function interpolateColor(
  start: [number, number, number],
  end: [number, number, number],
  amount: number,
): [number, number, number] {
  return start.map((value, index) => Math.round(value + (end[index] - value) * amount)) as [number, number, number];
}

function parseContinuousStyle(value: unknown): VolumeContinuousStyle | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const range = numberArray(value.range, 2);
  return {
    range: range ? [range[0], range[1]] : undefined,
    center: finiteNumber(value.center),
    scale: stringValue(value.scale),
    negativeColor: stringValue(value.negativeColor),
    centerColor: stringValue(value.centerColor),
    positiveColor: stringValue(value.positiveColor),
    outOfRangeColor: stringValue(value.outOfRangeColor),
    isovalue: finiteNumber(value.isovalue),
  };
}

function parseValidity(value: unknown): VolumeValidity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const noDataValues = Array.isArray(value.noDataValues)
    ? value.noDataValues.flatMap((item) => {
      const scalar = scalarValue(item);
      return scalar === undefined ? [] : [scalar];
    })
    : undefined;
  return {
    noDataValues,
    description: stringValue(value.description),
  };
}

function labelDefinitions(value: unknown): Record<string, VolumeLabelDefinition> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([key, definition]) => {
    if (typeof definition === "string") {
      return [[key, { name: definition }] as [string, VolumeLabelDefinition]];
    }
    if (!isRecord(definition)) {
      return [];
    }
    return [[key, {
      name: stringValue(definition.name),
      color: stringValue(definition.color),
      group: stringValue(definition.group),
      background: booleanValue(definition.background),
      hidden: booleanValue(definition.hidden),
    }] as [string, VolumeLabelDefinition]];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseAxisOrder(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return normalized.length === 3 && new Set(normalized).size === 3 && [...normalized].every((axis) => "xyz".includes(axis))
    ? normalized
    : undefined;
}

function numberArray(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  return value as number[];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scalarValue(value: unknown): number | string | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function baseFileName(name: string): string {
  return name.split("/").pop() ?? name;
}

function axisIndex(axis: string): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

function defaultIndexToWorld(index: number, dimension: number, association?: string): number {
  if (dimension <= 1) {
    return 0;
  }
  return association === "cell"
    ? -1 + (index + 0.5) * 2 / dimension
    : -1 + index * 2 / (dimension - 1);
}
