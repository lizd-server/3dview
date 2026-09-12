import type {
  CategoricalDisplayPreset,
  FieldMetadataPatch,
  FieldSemantic,
  FieldValue,
} from "./field-model.ts";
import { fieldValueKey, stableLabelColor } from "./field-model.ts";

export type PipelineVisualization =
  | "pipelineLabels"
  | "finalCclComponents"
  | "finalCclCases"
  | "componentLabels"
  | "boundaryMask"
  | "surfaceBoundaryClassification"
  | "linfinityDistanceCases"
  | "scalarField";

export type PipelineCategoryKey =
  | "unknown"
  | "outside"
  | "inside"
  | "surface"
  | "band"
  | "components"
  | "insideOnly"
  | "outsideOnly"
  | "bothSides"
  | "isolated"
  | "linfCase"
  | "surfaceBoundaryInside"
  | "surfaceBoundaryOutside";

export interface PipelineCategoryDefinition {
  key: PipelineCategoryKey;
  label: string;
  color: string;
}

export interface PipelineFieldPreset {
  id: PipelineVisualization;
  order: number;
  metadata: FieldMetadataPatch;
  group?: {
    prefix: string;
    role: PipelineGroupRole;
  };
}

export type PipelineGroupRole = "label" | "components" | "cases" | "insideFiltered" | "surfaceBoundary";

export const PIPELINE_CATEGORY_ORDER: readonly PipelineCategoryKey[] = [
  "unknown",
  "outside",
  "inside",
  "band",
  "surface",
  "components",
  "insideOnly",
  "outsideOnly",
  "bothSides",
  "isolated",
  "linfCase",
  "surfaceBoundaryInside",
  "surfaceBoundaryOutside",
];

export const PIPELINE_CATEGORIES: Record<PipelineCategoryKey, PipelineCategoryDefinition> = {
  unknown: { key: "unknown", label: "Unknown / background", color: "#1f2933" },
  outside: { key: "outside", label: "Outside", color: "#2563eb" },
  inside: { key: "inside", label: "Inside", color: "#dc2626" },
  surface: { key: "surface", label: "Surface barrier", color: "#000000" },
  band: { key: "band", label: "Unresolved band", color: "#facc15" },
  components: { key: "components", label: "CCL components", color: "#74b9ff" },
  insideOnly: { key: "insideOnly", label: "Inside-only case", color: "#22c55e" },
  outsideOnly: { key: "outsideOnly", label: "Outside-only case", color: "#a855f7" },
  bothSides: { key: "bothSides", label: "Both-sides case", color: "#f97316" },
  isolated: { key: "isolated", label: "Isolated case", color: "#06b6d4" },
  linfCase: { key: "linfCase", label: "L-infinity distance case", color: "#64748b" },
  surfaceBoundaryInside: {
    key: "surfaceBoundaryInside",
    label: "Surface boundary inside",
    color: "#39ff14",
  },
  surfaceBoundaryOutside: {
    key: "surfaceBoundaryOutside",
    label: "Surface boundary outside",
    color: "#ff00ff",
  },
};

const COMMON_PIPELINE_METADATA: FieldMetadataPatch = {
  association: "point",
  sourceAxisOrder: ["x", "y", "z"],
  coordinatePreset: "normalized",
};

const LABELS_METADATA: FieldMetadataPatch = {
  ...COMMON_PIPELINE_METADATA,
  semantic: "categorical",
  categoricalPreset: "semantic",
  labels: {
    "0": labelFromCategory("unknown", true),
    "1": labelFromCategory("outside"),
    "2": labelFromCategory("inside"),
    "3": labelFromCategory("band"),
    "4": labelFromCategory("surface"),
  },
};

const PRESET_METADATA: Record<PipelineVisualization, FieldMetadataPatch> = {
  pipelineLabels: LABELS_METADATA,
  boundaryMask: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "semantic",
    labels: {
      "0": labelFromCategory("unknown", true),
      "1": labelFromCategory("surface"),
    },
  },
  componentLabels: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "instances",
    labels: { "0": labelFromCategory("unknown", true) },
  },
  finalCclComponents: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "instances",
    labels: {
      "0": labelFromCategory("unknown", true),
      "1": labelFromCategory("outside"),
      "2": labelFromCategory("inside"),
      "3": labelFromCategory("surface"),
    },
  },
  finalCclCases: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "semantic",
    labels: {
      "0": labelFromCategory("unknown", true),
      "1": labelFromCategory("outside"),
      "2": labelFromCategory("inside"),
      "3": labelFromCategory("surface"),
      "4": labelFromCategory("insideOnly"),
      "5": labelFromCategory("outsideOnly"),
      "6": labelFromCategory("bothSides"),
      "7": labelFromCategory("isolated"),
    },
  },
  surfaceBoundaryClassification: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "semantic",
    labels: {
      "0": labelFromCategory("unknown", true),
      "1": labelFromCategory("outside"),
      "2": labelFromCategory("inside"),
      "3": labelFromCategory("surfaceBoundaryInside"),
      "4": labelFromCategory("surfaceBoundaryOutside"),
    },
  },
  linfinityDistanceCases: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "categorical",
    categoricalPreset: "instances",
  },
  scalarField: {
    ...COMMON_PIPELINE_METADATA,
    semantic: "continuous",
    continuousStyle: {
      range: [-0.1, 0.1],
      center: 0,
      scale: "sqrt",
      negativeColor: "#0d33f2",
      centerColor: "#ffffff",
      positiveColor: "#e60d0d",
      outOfRangeColor: "#000000",
      isovalue: 0,
    },
  },
};

for (const id of Object.keys(PRESET_METADATA) as PipelineVisualization[]) {
  PRESET_METADATA[id].stylePreset = id;
}

/** Infers only the legacy floodfill preset; unknown filenames remain valid generic fields. */
export function inferPipelinePreset(name: string): PipelineFieldPreset | null {
  const baseName = basenameWithoutNpy(name).toLowerCase();

  if (baseName === "000_initial_ccl_labels") {
    return preset("pipelineLabels", 0, { prefix: "000", role: "label" });
  }
  const finalCclMatch = /^(\d{3})_final_ccl_(labels|components|cases)$/.exec(baseName);
  if (finalCclMatch) {
    const prefix = finalCclMatch[1];
    const step = Number(prefix);
    if (finalCclMatch[2] === "labels") {
      return preset("pipelineLabels", step, { prefix, role: "label" });
    }
    if (finalCclMatch[2] === "components") {
      return preset("finalCclComponents", step + 0.1, { prefix, role: "components" });
    }
    return preset("finalCclCases", step + 0.2, { prefix, role: "cases" });
  }
  const insideFilteredMatch = /^(\d{3})_inside_filtered_labels$/.exec(baseName);
  if (insideFilteredMatch) {
    const step = Number(insideFilteredMatch[1]);
    return preset(
      "pipelineLabels",
      step,
      step > 0 ? { prefix: String(step - 1).padStart(3, "0"), role: "insideFiltered" } : undefined,
    );
  }
  if (/^\d{3}_(free_space_labels|final_labels)$/.test(baseName)) {
    return preset("pipelineLabels", pipelineStep(baseName));
  }
  if (/^\d{3}_(original|closed)_boundary$/.test(baseName)) {
    return preset("boundaryMask", pipelineStep(baseName));
  }
  if (/^\d{3}_pseudo_boundary_components$/.test(baseName)) {
    return preset("componentLabels", pipelineStep(baseName));
  }
  const surfaceBoundaryMatch = /^(\d{3})_surface_boundary_classification$/.exec(baseName);
  if (surfaceBoundaryMatch) {
    const step = Number(surfaceBoundaryMatch[1]);
    return preset(
      "surfaceBoundaryClassification",
      step,
      step > 2 ? { prefix: String(step - 2).padStart(3, "0"), role: "surfaceBoundary" } : undefined,
    );
  }
  if (baseName === "999_scalar_field") {
    return preset("scalarField", 999);
  }
  if (baseName === "999_linf_distance_cases") {
    return preset("linfinityDistanceCases", 999.1);
  }
  return null;
}

export function pipelineFileOrder(name: string): number | null {
  return inferPipelinePreset(name)?.order ?? null;
}

/** Legacy colors apply only while the resolved field keeps the preset semantics. */
export function applicablePipelineVisualization(
  name: string,
  semantic: FieldSemantic,
  categoricalPreset: CategoricalDisplayPreset,
): PipelineVisualization | undefined {
  const preset = inferPipelinePreset(name);
  if (!preset || semantic !== preset.metadata.semantic) {
    return undefined;
  }
  if (
    semantic === "categorical"
    && categoricalPreset !== (preset.metadata.categoricalPreset ?? "semantic")
  ) {
    return undefined;
  }
  return preset.id;
}

export function classifyPipelineValue(
  value: FieldValue,
  visualization: PipelineVisualization,
): PipelineCategoryKey | null {
  const label = integralPipelineValue(value);
  if (label === null || visualization === "scalarField") {
    return null;
  }
  const key = fieldValueKey(label);

  if (visualization === "boundaryMask") {
    return key === "0" ? "unknown" : "surface";
  }
  if (visualization === "componentLabels") {
    return key === "0" ? "unknown" : "components";
  }
  if (visualization === "linfinityDistanceCases") {
    return "linfCase";
  }
  if (visualization === "finalCclComponents") {
    if (key === "0") return "unknown";
    if (key === "1") return "outside";
    if (key === "2") return "inside";
    if (key === "3") return "surface";
    return greaterThan(label, 3) ? "components" : null;
  }
  if (visualization === "finalCclCases") {
    const categories: Record<string, PipelineCategoryKey> = {
      "0": "unknown",
      "1": "outside",
      "2": "inside",
      "3": "surface",
      "4": "insideOnly",
      "5": "outsideOnly",
      "6": "bothSides",
      "7": "isolated",
    };
    return categories[key] ?? "unknown";
  }
  if (visualization === "surfaceBoundaryClassification") {
    const categories: Record<string, PipelineCategoryKey> = {
      "0": "unknown",
      "1": "outside",
      "2": "inside",
      "3": "surfaceBoundaryInside",
      "4": "surfaceBoundaryOutside",
    };
    return categories[key] ?? "unknown";
  }

  const categories: Record<string, PipelineCategoryKey> = {
    "0": "unknown",
    "1": "outside",
    "2": "inside",
    "3": "band",
    "4": "surface",
  };
  return categories[key] ?? "unknown";
}

export function pipelineColorForValue(
  value: FieldValue,
  visualization: PipelineVisualization,
): [number, number, number] {
  if (visualization === "scalarField") {
    return legacyScalarColor(value);
  }
  if (visualization === "linfinityDistanceCases") {
    return legacyComponentColor(value);
  }
  const category = classifyPipelineValue(value, visualization);
  if (category === "components") {
    return legacyComponentColor(
      visualization === "finalCclComponents" ? subtractInteger(value, 3) : value,
    );
  }
  if (!category) {
    return [127, 127, 127];
  }
  return hexToRgb(PIPELINE_CATEGORIES[category].color);
}

export function pipelineCategoryDisplayName(key: PipelineCategoryKey): string {
  return PIPELINE_CATEGORIES[key].label;
}

function preset(
  id: PipelineVisualization,
  order: number,
  group?: PipelineFieldPreset["group"],
): PipelineFieldPreset {
  return { id, order, metadata: PRESET_METADATA[id], group };
}

function basenameWithoutNpy(name: string): string {
  const normalized = name.replace(/\\/g, "/");
  return (normalized.split("/").pop() ?? normalized).replace(/\.npy$/i, "");
}

function pipelineStep(baseName: string): number {
  return Number(/^(\d{3})_/.exec(baseName)?.[1] ?? 0);
}

function labelFromCategory(key: PipelineCategoryKey, background = false) {
  const category = PIPELINE_CATEGORIES[key];
  return { name: category.label, color: category.color, ...(background ? { background: true } : {}) };
}

function integralPipelineValue(value: FieldValue): FieldValue | null {
  if (typeof value === "bigint") {
    return value;
  }
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function greaterThan(value: FieldValue, threshold: number): boolean {
  return typeof value === "bigint" ? value > BigInt(threshold) : value > threshold;
}

function subtractInteger(value: FieldValue, amount: number): FieldValue {
  return typeof value === "bigint" ? value - BigInt(amount) : value - amount;
}

function legacyScalarColor(value: FieldValue): [number, number, number] {
  if (typeof value === "bigint" || !Number.isFinite(value) || Math.abs(value) > 0.1) {
    return [0, 0, 0];
  }
  const strength = Math.sqrt(Math.abs(value) / 0.1);
  const target: [number, number, number] = value >= 0 ? [0.9, 0.05, 0.05] : [0.05, 0.2, 0.95];
  return target.map((channel) => Math.round(clamp(1 - strength + channel * strength, 0, 1) * 255)) as [
    number,
    number,
    number,
  ];
}

function legacyComponentColor(value: FieldValue): [number, number, number] {
  const numeric = exactSafeInteger(value);
  if (numeric === null) {
    return hexToRgb(stableLabelColor(value));
  }
  const seed = Math.abs(Math.trunc(numeric));
  const hue = ((seed * 137.508) % 360) / 360;
  const [r, g, b] = hslToRgb(hue, 0.68, 0.57);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function exactSafeInteger(value: FieldValue): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    const integer = Math.trunc(value);
    return Number.isSafeInteger(integer) ? integer : null;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function hexToRgb(color: string): [number, number, number] {
  const hex = color.replace("#", "");
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    return [l, l, l];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
}

function hueToRgb(p: number, q: number, input: number): number {
  let t = input;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
