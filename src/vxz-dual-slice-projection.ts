import type { SliceAxis } from "./types";

export interface VxzDualSliceProjection {
  pixel: readonly [number, number];
  plane: readonly [number, number];
}

export function projectVxzDualVertexToSlice(
  axis: SliceAxis,
  coords: readonly [number, number, number],
  dual: readonly [number, number, number],
  resolution: number,
): VxzDualSliceProjection {
  const dualPosition: [number, number, number] = [
    coords[0] + dual[0] / 255,
    coords[1] + dual[1] / 255,
    coords[2] + dual[2] / 255,
  ];
  const horizontal = axis === "x" ? dualPosition[2] : dualPosition[0];
  const vertical = axis === "y" ? dualPosition[2] : dualPosition[1];
  const pixel: [number, number] = [horizontal, resolution - vertical];

  return {
    pixel,
    plane: [
      pixel[0] / resolution * 2 - 1,
      1 - pixel[1] / resolution * 2,
    ],
  };
}
