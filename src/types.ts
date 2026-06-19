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
export type RenderMode = "boundary" | "sparse" | "all";
export type SliceAxis = "none" | "x" | "y" | "z";
export type AxisOrder = "xyz" | "zyx";

export interface VolumeData {
  name: string;
  shape: [number, number, number];
  sourceShape: number[];
  data: NumericArray;
  dtype: string;
  fortranOrder: boolean;
  warnings: string[];
}

export interface CategoryDefinition {
  key: CategoryKey;
  label: string;
  color: string;
  defaultVisible: boolean;
  defaultOpacity: number;
}

export interface RenderSettings {
  schema: LabelSchema;
  renderMode: RenderMode;
  sampleStep: number;
  autoSample: boolean;
  maxVoxels: number;
  sliceAxis: SliceAxis;
  sliceIndex: number;
  sliceThickness: number;
  axisOrder: AxisOrder;
  flipX: boolean;
  flipY: boolean;
  flipZ: boolean;
  visibleCategories: Record<CategoryKey, boolean>;
}

export interface WorkerVolume {
  name: string;
  shape: [number, number, number];
  data: NumericArray;
  dtype: string;
  fortranOrder: boolean;
}

export interface WorkerGroup {
  key: CategoryKey;
  count: number;
  positions: Float32Array;
  indices: Uint32Array;
  labels: Float64Array;
  colors?: Float32Array;
}

export interface WorkerRenderResult {
  type: "rendered";
  requestId: number;
  groups: WorkerGroup[];
  cellSize: [number, number, number];
  dimsWorld: [number, number, number];
  stats: {
    scanned: number;
    emitted: number;
    capped: boolean;
    step: number;
    mode: RenderMode;
    elapsedMs: number;
  };
}

export interface WorkerStatus {
  type: "status";
  requestId: number;
  message: string;
}

export interface WorkerError {
  type: "error";
  requestId: number;
  message: string;
}

export type WorkerResponse = WorkerRenderResult | WorkerStatus | WorkerError;

export interface LoadVolumeRequest {
  type: "load";
  requestId: number;
  volume: WorkerVolume;
  settings: RenderSettings;
}

export interface RenderRequest {
  type: "render";
  requestId: number;
  settings: RenderSettings;
}

export type WorkerRequest = LoadVolumeRequest | RenderRequest;

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
    defaultVisible: false,
    defaultOpacity: 0.24,
  },
  outside: {
    key: "outside",
    label: "Outside",
    color: "#2563eb",
    defaultVisible: false,
    defaultOpacity: 0.16,
  },
  inside: {
    key: "inside",
    label: "Inside",
    color: "#dc2626",
    defaultVisible: true,
    defaultOpacity: 0.48,
  },
  surface: {
    key: "surface",
    label: "Surface barrier",
    color: "#080808",
    defaultVisible: true,
    defaultOpacity: 0.92,
  },
  band: {
    key: "band",
    label: "Unresolved band",
    color: "#facc15",
    defaultVisible: true,
    defaultOpacity: 0.62,
  },
  components: {
    key: "components",
    label: "CCL components",
    color: "#74b9ff",
    defaultVisible: true,
    defaultOpacity: 0.56,
  },
  insideOnly: {
    key: "insideOnly",
    label: "Inside-only case",
    color: "#22c55e",
    defaultVisible: true,
    defaultOpacity: 0.58,
  },
  outsideOnly: {
    key: "outsideOnly",
    label: "Outside-only case",
    color: "#a855f7",
    defaultVisible: true,
    defaultOpacity: 0.58,
  },
  bothSides: {
    key: "bothSides",
    label: "Both-sides case",
    color: "#f97316",
    defaultVisible: true,
    defaultOpacity: 0.58,
  },
  isolated: {
    key: "isolated",
    label: "Isolated case",
    color: "#06b6d4",
    defaultVisible: true,
    defaultOpacity: 0.58,
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
        return "insideOnly";
      case 2:
        return "outsideOnly";
      case 3:
        return "bothSides";
      case 4:
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
