/// <reference lib="webworker" />

import {
  CATEGORY_ORDER,
  classifyLabel,
  type CategoryKey,
  type RenderSettings,
  type SliceAxis,
  type WorkerGroup,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerVolume,
} from "./types";

interface MutableGroup {
  key: CategoryKey;
  positions: number[];
  indices: number[];
  labels: number[];
  colors: number[];
}

let activeVolume: WorkerVolume | null = null;

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === "load") {
      activeVolume = request.volume;
      postStatus(request.requestId, `Loaded ${request.volume.name}`);
      renderVolume(request.requestId, request.settings);
      return;
    }

    renderVolume(request.requestId, request.settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ type: "error", requestId: request.requestId, message } satisfies WorkerResponse);
  }
};

function renderVolume(requestId: number, settings: RenderSettings): void {
  if (!activeVolume) {
    postMessage({ type: "error", requestId, message: "No volume loaded." } satisfies WorkerResponse);
    return;
  }

  const started = performance.now();
  const { shape } = activeVolume;
  const dimsWorld = getWorldDims(shape, settings);
  const cellSize: [number, number, number] = [
    2 / dimsWorld[0],
    2 / dimsWorld[1],
    2 / dimsWorld[2],
  ];
  const ranges = getLoopRanges(shape, dimsWorld, settings);
  const step = resolveStep(shape, ranges, settings);
  const groups = new Map<CategoryKey, MutableGroup>();

  for (const key of CATEGORY_ORDER) {
    if (settings.visibleCategories[key]) {
      groups.set(key, {
        key,
        positions: [],
        indices: [],
        labels: [],
        colors: [],
      });
    }
  }

  let scanned = 0;
  let emitted = 0;
  let capped = false;
  const stepsByAxis = [step, step, step] as [number, number, number];
  if (settings.sliceAxis !== "none") {
    const slicedOriginalAxis = worldAxisToOriginalAxis(settings.sliceAxis, settings);
    stepsByAxis[slicedOriginalAxis] = 1;
  }

  scan:
  for (let i = ranges[0][0]; i <= ranges[0][1]; i += stepsByAxis[0]) {
    for (let j = ranges[1][0]; j <= ranges[1][1]; j += stepsByAxis[1]) {
      for (let k = ranges[2][0]; k <= ranges[2][1]; k += stepsByAxis[2]) {
        scanned += 1;

        const label = getValue(i, j, k);
        const key = classifyLabel(label, settings.schema);
        if (!key || !settings.visibleCategories[key]) {
          continue;
        }

        if (!passesSlice(i, j, k, dimsWorld, settings)) {
          continue;
        }

        if (settings.renderMode === "boundary" && !isBoundary(i, j, k, label)) {
          continue;
        }

        const group = groups.get(key);
        if (!group) {
          continue;
        }

        const [wx, wy, wz] = originalToWorldIndex(i, j, k, dimsWorld, settings);
        group.positions.push(
          -1 + (wx + 0.5) * cellSize[0],
          -1 + (wy + 0.5) * cellSize[1],
          -1 + (wz + 0.5) * cellSize[2],
        );
        group.indices.push(i, j, k);
        group.labels.push(label);

        if (key === "components") {
          const [r, g, b] = componentColor(label);
          group.colors.push(r, g, b);
        }

        emitted += 1;
        if (emitted >= settings.maxVoxels) {
          capped = true;
          break scan;
        }
      }
    }
  }

  const workerGroups: WorkerGroup[] = [...groups.values()]
    .filter((group) => group.labels.length > 0)
    .map((group) => ({
      key: group.key,
      count: group.labels.length,
      positions: new Float32Array(group.positions),
      indices: new Uint32Array(group.indices),
      labels: new Float64Array(group.labels),
      colors: group.colors.length > 0 ? new Float32Array(group.colors) : undefined,
    }));

  const transfer = workerGroups.flatMap((group) => {
    const buffers: Transferable[] = [
      group.positions.buffer,
      group.indices.buffer,
      group.labels.buffer,
    ];
    if (group.colors) {
      buffers.push(group.colors.buffer);
    }
    return buffers;
  });

  postMessage({
    type: "rendered",
    requestId,
    groups: workerGroups,
    cellSize,
    dimsWorld,
    stats: {
      scanned,
      emitted,
      capped,
      step,
      mode: settings.renderMode,
      elapsedMs: performance.now() - started,
    },
  } satisfies WorkerResponse, transfer);
}

function getValue(i: number, j: number, k: number): number {
  if (!activeVolume) {
    return Number.NaN;
  }

  const [nx, ny, nz] = activeVolume.shape;
  const offset = activeVolume.fortranOrder
    ? i + nx * (j + ny * k)
    : k + nz * (j + ny * i);

  return Number(activeVolume.data[offset]);
}

function isBoundary(i: number, j: number, k: number, label: number): boolean {
  if (!activeVolume) {
    return false;
  }

  const [nx, ny, nz] = activeVolume.shape;
  if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) {
    return true;
  }

  return (
    getValue(i - 1, j, k) !== label ||
    getValue(i + 1, j, k) !== label ||
    getValue(i, j - 1, k) !== label ||
    getValue(i, j + 1, k) !== label ||
    getValue(i, j, k - 1) !== label ||
    getValue(i, j, k + 1) !== label
  );
}

function getWorldDims(
  [nx, ny, nz]: [number, number, number],
  settings: RenderSettings,
): [number, number, number] {
  return settings.axisOrder === "xyz" ? [nx, ny, nz] : [nz, ny, nx];
}

function originalToWorldIndex(
  i: number,
  j: number,
  k: number,
  dimsWorld: [number, number, number],
  settings: RenderSettings,
): [number, number, number] {
  let x = settings.axisOrder === "xyz" ? i : k;
  let y = j;
  let z = settings.axisOrder === "xyz" ? k : i;

  if (settings.flipX) {
    x = dimsWorld[0] - 1 - x;
  }
  if (settings.flipY) {
    y = dimsWorld[1] - 1 - y;
  }
  if (settings.flipZ) {
    z = dimsWorld[2] - 1 - z;
  }

  return [x, y, z];
}

function passesSlice(
  i: number,
  j: number,
  k: number,
  dimsWorld: [number, number, number],
  settings: RenderSettings,
): boolean {
  if (settings.sliceAxis === "none") {
    return true;
  }

  const axisIndex = axisToIndex(settings.sliceAxis);
  const world = originalToWorldIndex(i, j, k, dimsWorld, settings);
  const [sliceMin, sliceMax] = getSliceBounds(settings.sliceIndex, settings.sliceThickness, dimsWorld[axisIndex]);

  return world[axisIndex] >= sliceMin && world[axisIndex] <= sliceMax;
}

function getLoopRanges(
  shape: [number, number, number],
  dimsWorld: [number, number, number],
  settings: RenderSettings,
): [[number, number], [number, number], [number, number]] {
  const ranges: [[number, number], [number, number], [number, number]] = [
    [0, shape[0] - 1],
    [0, shape[1] - 1],
    [0, shape[2] - 1],
  ];

  if (settings.sliceAxis === "none") {
    return ranges;
  }

  const worldAxis = axisToIndex(settings.sliceAxis);
  const originalAxis = worldAxisToOriginalAxis(settings.sliceAxis, settings);
  const [worldMin, worldMax] = getSliceBounds(settings.sliceIndex, settings.sliceThickness, dimsWorld[worldAxis]);
  const flipped = axisIsFlipped(settings.sliceAxis, settings);
  const originalA = flipped ? dimsWorld[worldAxis] - 1 - worldMin : worldMin;
  const originalB = flipped ? dimsWorld[worldAxis] - 1 - worldMax : worldMax;

  ranges[originalAxis] = [Math.min(originalA, originalB), Math.max(originalA, originalB)];
  return ranges;
}

function resolveStep(
  shape: [number, number, number],
  ranges: [[number, number], [number, number], [number, number]],
  settings: RenderSettings,
): number {
  const requested = Math.max(1, Math.floor(settings.sampleStep || 1));
  if (!settings.autoSample) {
    return requested;
  }

  const span = ranges.map(([min, max]) => Math.max(1, max - min + 1));
  const scanned = span[0] * span[1] * span[2];
  const scanBudget = settings.sliceAxis === "none" ? 2_500_000 : 1_200_000;
  const sampleRoot = settings.sliceAxis === "none" ? 3 : 2;
  const suggested = Math.ceil((scanned / scanBudget) ** (1 / sampleRoot));
  const componentAware = settings.renderMode === "all" ? Math.ceil((shape[0] * shape[1] * shape[2] / Math.max(1, settings.maxVoxels)) ** (1 / 3)) : 1;

  return Math.max(requested, suggested, componentAware, 1);
}

function worldAxisToOriginalAxis(axis: SliceAxis, settings: RenderSettings): 0 | 1 | 2 {
  if (axis === "y") {
    return 1;
  }

  if (settings.axisOrder === "xyz") {
    return axis === "x" ? 0 : 2;
  }

  return axis === "x" ? 2 : 0;
}

function axisIsFlipped(axis: SliceAxis, settings: RenderSettings): boolean {
  if (axis === "x") {
    return settings.flipX;
  }
  if (axis === "y") {
    return settings.flipY;
  }
  if (axis === "z") {
    return settings.flipZ;
  }
  return false;
}

function axisToIndex(axis: SliceAxis): 0 | 1 | 2 {
  if (axis === "x") {
    return 0;
  }
  if (axis === "y") {
    return 1;
  }
  return 2;
}

function componentColor(label: number): [number, number, number] {
  const seed = Math.abs(Math.trunc(label));
  const hue = ((seed * 137.508) % 360) / 360;
  return hslToRgb(hue, 0.68, 0.57);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    return [l, l, l];
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    hueToRgb(p, q, h + 1 / 3),
    hueToRgb(p, q, h),
    hueToRgb(p, q, h - 1 / 3),
  ];
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) {
    value += 1;
  }
  if (value > 1) {
    value -= 1;
  }
  if (value < 1 / 6) {
    return p + (q - p) * 6 * value;
  }
  if (value < 1 / 2) {
    return q;
  }
  if (value < 2 / 3) {
    return p + (q - p) * (2 / 3 - value) * 6;
  }
  return p;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getSliceBounds(center: number, thickness: number, dimension: number): [number, number] {
  const width = Math.max(1, Math.floor(thickness || 1));
  const lower = Math.floor((width - 1) / 2);
  const upper = Math.ceil((width - 1) / 2);
  return [
    clamp(center - lower, 0, dimension - 1),
    clamp(center + upper, 0, dimension - 1),
  ];
}

function postStatus(requestId: number, message: string): void {
  postMessage({ type: "status", requestId, message } satisfies WorkerResponse);
}
