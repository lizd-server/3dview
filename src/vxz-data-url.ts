export type VxzDataKind = "voxels" | "mesh";

export function vxzDataUrl(
  apiBase: string,
  jobId: string,
  kind: VxzDataKind,
  formatVersion: number,
  cacheVersion: number,
): string {
  return `${apiBase}/data?id=${encodeURIComponent(jobId)}`
    + `&kind=${encodeURIComponent(kind)}&format=${encodeURIComponent(formatVersion)}`
    + `&cache=${encodeURIComponent(cacheVersion)}`;
}
