export interface VxzQefRankDefinition {
  rank: number;
  label: string;
  color: string;
  rgb: readonly [number, number, number];
}

export const VXZ_QEF_RANKS: readonly VxzQefRankDefinition[] = [
  { rank: 0, label: "Rank 0 · deficient", color: "#be185d", rgb: [190, 24, 93] },
  { rank: 1, label: "Rank 1 · deficient", color: "#dc2626", rgb: [220, 38, 38] },
  { rank: 2, label: "Rank 2 · deficient", color: "#f59e0b", rgb: [245, 158, 11] },
  { rank: 3, label: "Rank 3 · full rank", color: "#10b981", rgb: [16, 185, 129] },
];

const UNAVAILABLE_COLOR: readonly [number, number, number] = [100, 116, 139];

export function vxzQefRankColor(rank: number): readonly [number, number, number] {
  return VXZ_QEF_RANKS[rank]?.rgb ?? UNAVAILABLE_COLOR;
}

export function vxzQefRankDeficient(rank: number): boolean | null {
  return Number.isInteger(rank) && rank >= 0 && rank <= 3 ? rank < 3 : null;
}

export function vxzQefRankDescription(rank: number): string {
  const deficient = vxzQefRankDeficient(rank);
  if (deficient === null) {
    return "Unavailable";
  }
  return deficient ? `${rank} · rank deficient` : `${rank} · full rank`;
}
