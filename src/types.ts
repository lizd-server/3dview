export type NumericArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type CategoryKey =
  | "unknown"
  | "outside"
  | "inside"
  | "surface"
  | "band"
  | "components"
  | "insideOnly"
  | "outsideOnly"
  | "bothSides"
  | "isolated";

export type LabelSchema = "semantic" | "components" | "cases";
export type SliceAxis = "x" | "y" | "z";
export type AxisOrder = "xyz" | "zyx";
export type VolumeVisualization = "raw" | "pipelineLabels" | "componentOverlay" | "caseOverlay";

export const COMPONENT_OVERLAY_OFFSET = 1_000_000;
export const CASE_OVERLAY_OFFSET = 2_000_000;

export interface VolumeData {
  name: string;
  shape: [number, number, number];
  sourceShape: number[];
  data: NumericArray;
  dtype: string;
  fortranOrder: boolean;
  warnings: string[];
  visualization?: VolumeVisualization;
}

export interface CategoryDefinition {
  key: CategoryKey;
  label: string;
  color: string;
  visibleInLegend: boolean;
}

export const CATEGORY_ORDER: CategoryKey[] = [
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
];

export const CATEGORIES: Record<CategoryKey, CategoryDefinition> = {
  unknown: {
    key: "unknown",
    label: "Unknown / background",
    color: "#1f2933",
    visibleInLegend: true,
  },
  outside: {
    key: "outside",
    label: "Outside",
    color: "#2563eb",
    visibleInLegend: true,
  },
  inside: {
    key: "inside",
    label: "Inside",
    color: "#dc2626",
    visibleInLegend: true,
  },
  surface: {
    key: "surface",
    label: "Surface barrier",
    color: "#000000",
    visibleInLegend: true,
  },
  band: {
    key: "band",
    label: "Unresolved band",
    color: "#facc15",
    visibleInLegend: true,
  },
  components: {
    key: "components",
    label: "CCL components",
    color: "#74b9ff",
    visibleInLegend: true,
  },
  insideOnly: {
    key: "insideOnly",
    label: "Inside-only case",
    color: "#22c55e",
    visibleInLegend: true,
  },
  outsideOnly: {
    key: "outsideOnly",
    label: "Outside-only case",
    color: "#a855f7",
    visibleInLegend: true,
  },
  bothSides: {
    key: "bothSides",
    label: "Both-sides case",
    color: "#f97316",
    visibleInLegend: true,
  },
  isolated: {
    key: "isolated",
    label: "Isolated case",
    color: "#06b6d4",
    visibleInLegend: true,
  },
};

export function classifyLabel(value: number, schema: LabelSchema): CategoryKey | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const label = Math.trunc(value);

  if (schema === "components") {
    return label === 0 ? "unknown" : "components";
  }

  if (schema === "cases") {
    switch (label) {
      case 0:
        return "unknown";
      case 1:
        return "outside";
      case 2:
        return "inside";
      case 3:
        return "surface";
      case 4:
        return "insideOnly";
      case 5:
        return "outsideOnly";
      case 6:
        return "bothSides";
      case 7:
        return "isolated";
      default:
        return "components";
    }
  }

  switch (label) {
    case 0:
      return "unknown";
    case 1:
      return "outside";
    case 2:
      return "inside";
    case 3:
      return "band";
    case 4:
      return "surface";
    default:
      return "components";
  }
}

export function categoryDisplayName(key: CategoryKey): string {
  return CATEGORIES[key].label;
}
