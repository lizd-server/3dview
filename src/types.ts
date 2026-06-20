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

export type SliceAxis = "x" | "y" | "z";
export type VolumeVisualization =
  | "pipelineLabels"
  | "finalCclComponents"
  | "finalCclCases";

export interface VolumeData {
  name: string;
  shape: [number, number, number];
  sourceShape: number[];
  data: NumericArray;
  dtype: string;
  fortranOrder: boolean;
  warnings: string[];
  visualization: VolumeVisualization;
}

export interface CategoryDefinition {
  key: CategoryKey;
  label: string;
  color: string;
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
  },
  outside: {
    key: "outside",
    label: "Outside",
    color: "#2563eb",
  },
  inside: {
    key: "inside",
    label: "Inside",
    color: "#dc2626",
  },
  surface: {
    key: "surface",
    label: "Surface barrier",
    color: "#000000",
  },
  band: {
    key: "band",
    label: "Unresolved band",
    color: "#facc15",
  },
  components: {
    key: "components",
    label: "CCL components",
    color: "#74b9ff",
  },
  insideOnly: {
    key: "insideOnly",
    label: "Inside-only case",
    color: "#22c55e",
  },
  outsideOnly: {
    key: "outsideOnly",
    label: "Outside-only case",
    color: "#a855f7",
  },
  bothSides: {
    key: "bothSides",
    label: "Both-sides case",
    color: "#f97316",
  },
  isolated: {
    key: "isolated",
    label: "Isolated case",
    color: "#06b6d4",
  },
};

export function classifyVolumeLabel(value: number, visualization: VolumeVisualization): CategoryKey | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const label = Math.trunc(value);

  if (visualization === "finalCclComponents") {
    switch (label) {
      case 0:
        return "unknown";
      case 1:
        return "outside";
      case 2:
        return "inside";
      case 3:
        return "surface";
      default:
        return label > 3 ? "components" : null;
    }
  }

  if (visualization === "finalCclCases") {
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
        return "unknown";
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
      return "unknown";
  }
}

export function categoryDisplayName(key: CategoryKey): string {
  return CATEGORIES[key].label;
}
