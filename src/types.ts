export type SliceAxis = "x" | "y" | "z";
export type VxzColorMode = "occupancy" | "edges" | "dual" | "fallback" | "rank";

export interface VxzMetadata {
  formatVersion: number;
  cacheVersion: number;
  sourceName: string;
  resolution: number;
  resolutionSource?: "inferred" | "explicit";
  voxelCount: number;
  quadCount: number;
  faceCount: number;
  previewVoxelCount: number;
  previewVertexCount: number;
  previewFaceCount: number;
  previewMode?: "vertex-clustered";
  previewClusterWidth?: number;
  hasOvoxelType?: boolean;
  ovoxelTypeCounts?: [number, number, number, number];
  hasQefRank?: boolean;
  qefRankCounts?: [number, number, number, number];
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
