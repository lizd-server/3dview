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
  | "isolated"
  | "linfCase"
  | "surfaceBoundaryInside"
  | "surfaceBoundaryOutside";

export type SliceAxis = "x" | "y" | "z";
export type VxzColorMode = "occupancy" | "edges" | "dual";
export type VolumeVisualization =
  | "pipelineLabels"
  | "finalCclComponents"
  | "finalCclCases"
  | "componentLabels"
  | "boundaryMask"
  | "surfaceBoundaryClassification"
  | "linfinityDistanceCases"
  | "scalarField";

export interface VolumeData {
  name: string;
  shape: [number, number, number];
  sourceShape: number[];
  data: NumericArray;
  dtype: string;
  fortranOrder: boolean;
  warnings: string[];
  visualization: VolumeVisualization;
  labelMetadata?: VolumeLabelMetadata;
}

export interface VolumeLabelMetadata {
  kind?: string;
  labels?: Record<string, string>;
  dynamicLabels?: Record<string, string>;
  valueDescription?: string;
  isovalue?: number;
}

export interface VxzMetadata {
  formatVersion: number;
  sourceName: string;
  resolution: number;
  resolutionSource?: "inferred" | "explicit";
  voxelCount: number;
  quadCount: number;
  faceCount: number;
  previewVoxelCount: number;
  previewVertexCount: number;
  previewFaceCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
  gridMin: [number, number, number];
  gridMax: [number, number, number];
  elapsedSeconds: number;
}

export interface VxzJobResponse {
  id: string;
  sourceName: string;
  status: "processing" | "ready" | "failed";
  stage: string;
  progress: number;
  message: string;
  error: string | null;
  metadata: VxzMetadata | null;
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
  "linfCase",
  "surfaceBoundaryInside",
  "surfaceBoundaryOutside",
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
  linfCase: {
    key: "linfCase",
    label: "L-infinity distance case",
    color: "#64748b",
  },
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

export function classifyVolumeLabel(value: number, visualization: VolumeVisualization): CategoryKey | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  if (visualization === "scalarField") {
    return null;
  }

  const label = Math.trunc(value);

  if (visualization === "boundaryMask") {
    return label === 0 ? "unknown" : "surface";
  }

  if (visualization === "componentLabels") {
    return label === 0 ? "unknown" : "components";
  }

  if (visualization === "linfinityDistanceCases") {
    return "linfCase";
  }

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

  if (visualization === "surfaceBoundaryClassification") {
    switch (label) {
      case 0:
        return "unknown";
      case 1:
        return "outside";
      case 2:
        return "inside";
      case 3:
        return "surfaceBoundaryInside";
      case 4:
        return "surfaceBoundaryOutside";
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
