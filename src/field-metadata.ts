import type {
  CategoricalDisplayPreset,
  ContinuousScale,
  ContinuousStyle,
  CoordinatePreset,
  CoordinateSource,
  FieldMetadataPatch,
  FieldSemantic,
  FieldValidity,
  GridAssociation,
  LabelDefinition,
  LabelSchema,
  Matrix4,
  NpyArray3D,
  ResolvedFieldDefinition,
  SemanticSource,
  SourceAxisOrder,
} from "./field-model.ts";
import { fieldValueKey } from "./field-model.ts";
import {
  assertIndexToWorld,
  createPresetIndexToWorld,
  isSourceAxisOrder,
  sourceShapeToLogicalShape,
  XYZ_SOURCE_AXIS_ORDER,
} from "./grid-field.ts";
import type { PipelineFieldPreset } from "./pipeline-presets.ts";
import { normalizeNumericValueForNpyDtype } from "./volumeLoader.ts";

export type FieldManifestFormat = "fields" | "legacy" | "unknown";

export interface ParsedFieldManifest {
  sourceName: string;
  format: FieldManifestFormat;
  defaults: FieldMetadataPatch;
  fields: Map<string, FieldMetadataPatch>;
  warnings: string[];
}

export interface ResolveFieldDefinitionOptions {
  preset?: PipelineFieldPreset | null;
  manifest?: ParsedFieldManifest;
  metadata?: FieldMetadataPatch;
  userOverrides?: FieldMetadataPatch;
}

interface CoordinateLayer {
  patch: FieldMetadataPatch;
  source: CoordinateSource;
}

export function parseFieldManifest(text: string, sourceName = "fields.json"): ParsedFieldManifest {
  const result: ParsedFieldManifest = {
    sourceName,
    format: "unknown",
    defaults: {},
    fields: new Map(),
    warnings: [],
  };

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    result.warnings.push(`${sourceName}: invalid JSON (${errorMessage(error)}).`);
    return result;
  }
  if (!isRecord(root)) {
    result.warnings.push(`${sourceName}: the manifest root must be an object.`);
    return result;
  }

  if (isRecord(root.fields)) {
    result.format = "fields";
    if (root.defaults !== undefined) {
      result.defaults = parseMetadataPatch(root.defaults, `${sourceName}.defaults`, result.warnings);
    }
    for (const [name, rawMetadata] of Object.entries(root.fields)) {
      addManifestField(
        result,
        name,
        parseMetadataPatch(rawMetadata, `${sourceName}.fields[${JSON.stringify(name)}]`, result.warnings),
      );
    }
    return result;
  }

  if (isRecord(root.files)) {
    result.format = "legacy";
    for (const [name, rawMetadata] of Object.entries(root.files)) {
      addManifestField(
        result,
        name,
        parseLegacyMetadataPatch(rawMetadata, `${sourceName}.files[${JSON.stringify(name)}]`, result.warnings),
      );
    }
    return result;
  }

  result.warnings.push(`${sourceName}: expected a \"fields\" object or legacy \"files\" object.`);
  return result;
}

export function fieldMetadataFor(
  manifest: ParsedFieldManifest | undefined,
  fieldName: string,
): FieldMetadataPatch | undefined {
  if (!manifest) {
    return undefined;
  }
  const name = manifestFieldName(fieldName);
  const exact = manifest.fields.get(name);
  if (exact) {
    return exact;
  }
  const lowerName = name.toLowerCase();
  const matches = Array.from(manifest.fields.entries()).filter(([candidate]) => candidate.toLowerCase() === lowerName);
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function mergeFieldMetadataPatches(...patches: Array<FieldMetadataPatch | undefined>): FieldMetadataPatch {
  const result: FieldMetadataPatch = {};
  let labels: LabelSchema | undefined;
  let continuousStyle: ContinuousStyle | undefined;

  for (const patch of patches) {
    if (!patch) {
      continue;
    }
    if (patch.semantic !== undefined) result.semantic = patch.semantic;
    if (patch.categoricalPreset !== undefined) result.categoricalPreset = patch.categoricalPreset;
    if (patch.association !== undefined) result.association = patch.association;
    if (patch.sourceAxisOrder !== undefined) result.sourceAxisOrder = [...patch.sourceAxisOrder] as SourceAxisOrder;
    if (patch.coordinatePreset !== undefined) {
      result.coordinatePreset = patch.coordinatePreset;
      delete result.indexToWorld;
    }
    if (patch.indexToWorld !== undefined) {
      result.indexToWorld = [...patch.indexToWorld] as Matrix4;
      delete result.coordinatePreset;
    }
    if (patch.valueDescription !== undefined) result.valueDescription = patch.valueDescription;
    if (patch.stylePreset !== undefined) result.stylePreset = patch.stylePreset;
    if (patch.validity !== undefined) result.validity = { ...result.validity, ...patch.validity };
    if (patch.sparseDefault !== undefined) result.sparseDefault = patch.sparseDefault;
    if (patch.labels !== undefined) {
      labels ??= {};
      for (const [key, definition] of Object.entries(patch.labels)) {
        labels[key] = { ...labels[key], ...definition };
      }
    }
    if (patch.continuousStyle !== undefined) {
      continuousStyle = { ...continuousStyle, ...patch.continuousStyle };
    }
  }

  if (labels) result.labels = labels;
  if (continuousStyle) result.continuousStyle = continuousStyle;
  return result;
}

export function inferSemanticFromDtype(dtype: string): FieldSemantic {
  const match = /^[<>=|]?([biuf])\d+$/.exec(dtype.trim().toLowerCase());
  return match && (match[1] === "b" || match[1] === "i" || match[1] === "u")
    ? "categorical"
    : "continuous";
}

export function resolveFieldDefinition(
  array: NpyArray3D,
  options: ResolveFieldDefinitionOptions = {},
): ResolvedFieldDefinition {
  const manifestMetadata = fieldMetadataFor(options.manifest, array.name);
  const metadataPatch = mergeFieldMetadataPatches(
    options.manifest?.defaults,
    manifestMetadata,
    options.metadata,
  );
  const semanticResolution = resolveSemantic(
    array.dtype,
    options.preset?.metadata,
    metadataPatch,
    options.userOverrides,
  );
  const initialMerged = mergeFieldMetadataPatches(
    options.preset?.metadata,
    metadataPatch,
    options.userOverrides,
  );
  const categoricalPreset = initialMerged.categoricalPreset ?? "semantic";
  const presetMetadata = applicablePresetMetadata(
    options.preset?.metadata,
    semanticResolution.semantic,
    categoricalPreset,
  );
  const merged = mergeFieldMetadataPatches(
    presetMetadata,
    metadataPatch,
    options.userOverrides,
  );
  const association = merged.association ?? "point";
  const sourceAxisOrder = merged.sourceAxisOrder ?? XYZ_SOURCE_AXIS_ORDER;
  const logicalShape = sourceShapeToLogicalShape(array.sourceShape, sourceAxisOrder);
  const coordinate = resolveCoordinate(
    logicalShape,
    association,
    [
      ...(options.preset ? [{ patch: options.preset.metadata, source: "preset" as const }] : []),
      ...(options.manifest?.defaults
        ? [{ patch: options.manifest.defaults, source: "metadata" as const }]
        : []),
      ...(manifestMetadata ? [{ patch: manifestMetadata, source: "metadata" as const }] : []),
      ...(options.metadata ? [{ patch: options.metadata, source: "metadata" as const }] : []),
      ...(options.userOverrides ? [{ patch: options.userOverrides, source: "user" as const }] : []),
    ],
  );

  return {
    name: array.name,
    semantic: semanticResolution.semantic,
    semanticSource: semanticResolution.source,
    categoricalPreset,
    association,
    sourceAxisOrder,
    logicalShape,
    indexToWorld: coordinate.indexToWorld,
    coordinateSource: coordinate.source,
    coordinatePreset: coordinate.preset,
    labels: normalizeLabelSchemaForDtype(merged.labels ?? {}, array.dtype),
    continuousStyle: merged.continuousStyle ?? {},
    validity: normalizeValidityForDtype(merged.validity ?? {}, array.dtype),
    sparseDefault: merged.sparseDefault === undefined
      ? undefined
      : normalizeExactKeyForDtype(merged.sparseDefault, array.dtype),
    valueDescription: merged.valueDescription,
    stylePreset: merged.stylePreset,
    presetId: options.preset?.id,
  };
}

function normalizeValidityForDtype(validity: FieldValidity, dtype: string): FieldValidity {
  return {
    ...validity,
    ...(validity.noDataValues
      ? { noDataValues: validity.noDataValues.map((key) => normalizeExactKeyForDtype(key, dtype)) }
      : {}),
  };
}

function normalizeLabelSchemaForDtype(labels: LabelSchema, dtype: string): LabelSchema {
  const normalized: LabelSchema = {};
  for (const [key, definition] of Object.entries(labels)) {
    const normalizedKey = normalizeExactKeyForDtype(key, dtype);
    normalized[normalizedKey] = { ...normalized[normalizedKey], ...definition };
  }
  return normalized;
}

function normalizeExactKeyForDtype(key: string, dtype: string): string {
  if (!/^[<>=|]?f(?:2|4|8)$/i.test(dtype.trim())) {
    return key;
  }
  const numeric = /^nan$/i.test(key) ? Number.NaN : Number(key);
  if (Number.isNaN(numeric) && !/^nan$/i.test(key)) {
    return key;
  }
  return fieldValueKey(normalizeNumericValueForNpyDtype(numeric, dtype));
}

function applicablePresetMetadata(
  preset: FieldMetadataPatch | undefined,
  semantic: FieldSemantic,
  categoricalPreset: CategoricalDisplayPreset,
): FieldMetadataPatch | undefined {
  if (!preset) {
    return undefined;
  }
  const visualizationApplies = preset.semantic === semantic
    && (
      semantic !== "categorical"
      || categoricalPreset === (preset.categoricalPreset ?? "semantic")
    );
  if (visualizationApplies) {
    return preset;
  }
  const structuralMetadata = { ...preset };
  delete structuralMetadata.labels;
  delete structuralMetadata.continuousStyle;
  delete structuralMetadata.stylePreset;
  delete structuralMetadata.valueDescription;
  return structuralMetadata;
}

function resolveSemantic(
  dtype: string,
  preset: FieldMetadataPatch | undefined,
  metadata: FieldMetadataPatch,
  user: FieldMetadataPatch | undefined,
): { semantic: FieldSemantic; source: SemanticSource } {
  if (user?.semantic) {
    return { semantic: user.semantic, source: "user" };
  }
  if (metadata.semantic) {
    return { semantic: metadata.semantic, source: "metadata" };
  }
  if (preset?.semantic) {
    return { semantic: preset.semantic, source: "preset" };
  }
  return { semantic: inferSemanticFromDtype(dtype), source: "dtype" };
}

function resolveCoordinate(
  logicalShape: readonly [number, number, number],
  association: GridAssociation,
  layers: CoordinateLayer[],
): { indexToWorld: Matrix4; source: CoordinateSource; preset?: CoordinatePreset } {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const { patch, source } = layers[index];
    if (patch.indexToWorld) {
      return { indexToWorld: patch.indexToWorld, source };
    }
    if (patch.coordinatePreset) {
      return {
        indexToWorld: createPresetIndexToWorld(patch.coordinatePreset, logicalShape, association),
        source,
        preset: patch.coordinatePreset,
      };
    }
  }
  return {
    indexToWorld: createPresetIndexToWorld("index", logicalShape, association),
    source: "index",
    preset: "index",
  };
}

function parseMetadataPatch(value: unknown, path: string, warnings: string[]): FieldMetadataPatch {
  if (!isRecord(value)) {
    warnings.push(`${path}: field metadata must be an object.`);
    return {};
  }
  const result: FieldMetadataPatch = {};
  result.semantic = enumValue(value.semantic, ["categorical", "continuous"], `${path}.semantic`, warnings);
  result.categoricalPreset = enumValue(
    value.categoricalPreset ?? value.categorical_preset,
    ["semantic", "instances"],
    `${path}.categoricalPreset`,
    warnings,
  ) as CategoricalDisplayPreset | undefined;
  result.association = parseAssociation(value.association, `${path}.association`, warnings);
  result.sourceAxisOrder = parseSourceAxisOrder(
    value.sourceAxisOrder ?? value.axisOrder ?? value.source_axis_order ?? value.axis_order,
    `${path}.sourceAxisOrder`,
    warnings,
  );
  result.coordinatePreset = enumValue(
    value.coordinatePreset ?? value.coordinate_preset,
    ["index", "normalized"],
    `${path}.coordinatePreset`,
    warnings,
  ) as CoordinatePreset | undefined;
  result.indexToWorld = parseIndexToWorld(
    value.indexToWorld ?? value.index_to_world,
    `${path}.indexToWorld`,
    warnings,
  );
  if (result.coordinatePreset && result.indexToWorld) {
    warnings.push(`${path}: indexToWorld takes precedence over coordinatePreset.`);
  }
  result.labels = parseLabels(value.labels ?? value.labelSchema ?? value.label_schema, `${path}.labels`, warnings);
  result.continuousStyle = parseContinuousStyle(
    value.continuousStyle ?? value.continuous_style,
    `${path}.continuousStyle`,
    warnings,
  );
  result.valueDescription = optionalString(
    value.valueDescription ?? value.value_description,
    `${path}.valueDescription`,
    warnings,
  );
  result.stylePreset = optionalString(value.stylePreset ?? value.style_preset, `${path}.stylePreset`, warnings);
  result.validity = parseValidity(value.validity, `${path}.validity`, warnings);
  result.sparseDefault = optionalValueKey(
    value.sparseDefault ?? value.sparse_default,
    `${path}.sparseDefault`,
    warnings,
  );
  return removeUndefined(result);
}

function parseLegacyMetadataPatch(value: unknown, path: string, warnings: string[]): FieldMetadataPatch {
  if (!isRecord(value)) {
    warnings.push(`${path}: legacy field metadata must be an object.`);
    return {};
  }
  const result = parseMetadataPatch(value, path, warnings);
  if (!result.semantic && typeof value.kind === "string") {
    result.semantic = semanticFromLegacyKind(value.kind);
  }
  const dynamicLabels = parseLabels(value.dynamic_labels, `${path}.dynamic_labels`, warnings);
  result.labels = mergeFieldMetadataPatches(
    { labels: dynamicLabels },
    { labels: result.labels },
  ).labels;
  const isovalue = optionalFiniteNumber(value.isovalue, `${path}.isovalue`, warnings);
  if (isovalue !== undefined) {
    result.continuousStyle = { ...result.continuousStyle, isovalue };
  }
  return removeUndefined(result);
}

function parseAssociation(value: unknown, path: string, warnings: string[]): GridAssociation | undefined {
  if (value === undefined) return undefined;
  if (value === "node") return "point";
  return enumValue(value, ["point", "cell"], path, warnings) as GridAssociation | undefined;
}

function parseSourceAxisOrder(value: unknown, path: string, warnings: string[]): SourceAxisOrder | undefined {
  if (value === undefined) return undefined;
  const candidate = typeof value === "string" ? value.toLowerCase().split("") : value;
  if (isSourceAxisOrder(candidate)) {
    return [...candidate] as SourceAxisOrder;
  }
  warnings.push(`${path}: expected a permutation such as [\"x\", \"y\", \"z\"] or \"zyx\".`);
  return undefined;
}

function parseIndexToWorld(value: unknown, path: string, warnings: string[]): Matrix4 | undefined {
  if (value === undefined) return undefined;
  const flat = Array.isArray(value) && value.length === 4 && value.every((row) => Array.isArray(row))
    ? value.flat()
    : value;
  if (!Array.isArray(flat) || flat.length !== 16 || flat.some((entry) => typeof entry !== "number")) {
    warnings.push(`${path}: expected 16 row-major numbers or a 4 x 4 number array.`);
    return undefined;
  }
  try {
    assertIndexToWorld(flat);
    return [...flat] as unknown as Matrix4;
  } catch (error) {
    warnings.push(`${path}: ${errorMessage(error)}`);
    return undefined;
  }
}

function parseLabels(value: unknown, path: string, warnings: string[]): LabelSchema | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`${path}: expected an object keyed by exact label IDs.`);
    return undefined;
  }
  const labels: LabelSchema = {};
  for (const [key, rawDefinition] of Object.entries(value)) {
    if (typeof rawDefinition === "string") {
      labels[key] = { name: rawDefinition };
      continue;
    }
    if (!isRecord(rawDefinition)) {
      warnings.push(`${path}[${JSON.stringify(key)}]: expected a string or label object.`);
      continue;
    }
    const definition: LabelDefinition = {};
    definition.name = optionalString(rawDefinition.name, `${path}[${JSON.stringify(key)}].name`, warnings);
    definition.group = optionalString(rawDefinition.group, `${path}[${JSON.stringify(key)}].group`, warnings);
    definition.color = optionalColor(rawDefinition.color, `${path}[${JSON.stringify(key)}].color`, warnings);
    definition.background = optionalBoolean(
      rawDefinition.background,
      `${path}[${JSON.stringify(key)}].background`,
      warnings,
    );
    definition.hidden = optionalBoolean(rawDefinition.hidden, `${path}[${JSON.stringify(key)}].hidden`, warnings);
    labels[key] = removeUndefined(definition);
  }
  return labels;
}

function parseContinuousStyle(value: unknown, path: string, warnings: string[]): ContinuousStyle | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`${path}: expected an object.`);
    return undefined;
  }
  const style: ContinuousStyle = {};
  if (value.range !== undefined) {
    if (value.range === null) {
      style.range = null;
    } else if (
      Array.isArray(value.range)
      && value.range.length === 2
      && value.range.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      && value.range[0] < value.range[1]
    ) {
      style.range = [value.range[0], value.range[1]];
    } else {
      warnings.push(`${path}.range: expected null or two increasing finite numbers.`);
    }
  }
  style.center = optionalFiniteNumber(value.center, `${path}.center`, warnings);
  style.scale = enumValue(value.scale, ["linear", "sqrt"], `${path}.scale`, warnings) as ContinuousScale | undefined;
  style.negativeColor = optionalColor(value.negativeColor ?? value.negative_color, `${path}.negativeColor`, warnings);
  style.centerColor = optionalColor(value.centerColor ?? value.center_color, `${path}.centerColor`, warnings);
  style.positiveColor = optionalColor(value.positiveColor ?? value.positive_color, `${path}.positiveColor`, warnings);
  style.outOfRangeColor = optionalColor(
    value.outOfRangeColor ?? value.out_of_range_color,
    `${path}.outOfRangeColor`,
    warnings,
  );
  style.isovalue = optionalFiniteNumber(value.isovalue, `${path}.isovalue`, warnings);
  return removeUndefined(style);
}

function parseValidity(value: unknown, path: string, warnings: string[]): FieldValidity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    warnings.push(`${path}: expected an object.`);
    return undefined;
  }
  const validity: FieldValidity = {};
  const rawNoData = value.noDataValues ?? value.no_data_values;
  if (rawNoData !== undefined) {
    if (!Array.isArray(rawNoData)) {
      warnings.push(`${path}.noDataValues: expected an array of exact value keys or finite numbers.`);
    } else {
      const keys = rawNoData
        .map((entry, index) => optionalValueKey(entry, `${path}.noDataValues[${index}]`, warnings))
        .filter((entry): entry is string => entry !== undefined);
      validity.noDataValues = keys;
    }
  }
  validity.description = optionalString(value.description, `${path}.description`, warnings);
  return removeUndefined(validity);
}

function optionalValueKey(value: unknown, path: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      warnings.push(`${path}: integer IDs outside JavaScript's safe range must be quoted strings.`);
      return undefined;
    }
    return fieldValueKey(value);
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  warnings.push(`${path}: expected a non-empty exact value key or finite number.`);
  return undefined;
}

function semanticFromLegacyKind(kind: string): FieldSemantic | undefined {
  const normalized = kind.toLowerCase();
  if (/(scalar|distance|sdf|confidence|error|continuous)/.test(normalized)) {
    return "continuous";
  }
  if (/(label|component|case|mask|categorical|classification)/.test(normalized)) {
    return "categorical";
  }
  return undefined;
}

function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
  warnings: string[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && choices.includes(value as T)) {
    return value as T;
  }
  warnings.push(`${path}: expected one of ${choices.join(", ")}.`);
  return undefined;
}

function optionalString(value: unknown, path: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  warnings.push(`${path}: expected a string.`);
  return undefined;
}

function optionalBoolean(value: unknown, path: string, warnings: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  warnings.push(`${path}: expected a boolean.`);
  return undefined;
}

function optionalFiniteNumber(value: unknown, path: string, warnings: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  warnings.push(`${path}: expected a finite number.`);
  return undefined;
}

function optionalColor(value: unknown, path: string, warnings: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  warnings.push(`${path}: expected a six-digit hex color such as #2563eb.`);
  return undefined;
}

function addManifestField(result: ParsedFieldManifest, name: string, metadata: FieldMetadataPatch): void {
  const normalizedName = manifestFieldName(name);
  if (result.fields.has(normalizedName)) {
    result.warnings.push(`${result.sourceName}: duplicate metadata for ${normalizedName}; the later entry wins.`);
  }
  result.fields.set(normalizedName, metadata);
}

function manifestFieldName(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? normalized;
}

function removeUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
