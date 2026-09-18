export function vxzDataUrl(
  apiBase: string,
  jobId: string,
  kind: "voxels" | "mesh",
  formatVersion: number,
  cacheVersion: number,
): string {
  return `${apiBase}/data?id=${encodeURIComponent(jobId)}&kind=${kind}`
    + `&format=${formatVersion}&cache=${cacheVersion}`;
}
