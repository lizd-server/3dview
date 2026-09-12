import type { Index3, LogicalAxis, Shape3 } from "./field-model";

export interface SliceIndices {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ViewerState {
  readonly activeAxis: LogicalAxis;
  readonly sliceIndices: SliceIndices;
  readonly pinnedGridPoint: Index3 | null;
}

const AXIS_INDEX: Record<LogicalAxis, 0 | 1 | 2> = {
  x: 0,
  y: 1,
  z: 2,
};

export function createViewerState(
  logicalShape: Shape3,
  activeAxis: LogicalAxis = "z",
): ViewerState {
  assertLogicalShape(logicalShape);
  return {
    activeAxis,
    sliceIndices: {
      x: Math.floor((logicalShape[0] - 1) / 2),
      y: Math.floor((logicalShape[1] - 1) / 2),
      z: Math.floor((logicalShape[2] - 1) / 2),
    },
    pinnedGridPoint: null,
  };
}

/** Pinning one logical grid point links all three orthogonal slice indices. */
export function pinGridPoint(
  state: ViewerState,
  point: Index3,
  logicalShape: Shape3,
): ViewerState {
  const pinnedGridPoint = clampGridPoint(point, logicalShape);
  return {
    ...state,
    sliceIndices: sliceIndicesFromPoint(pinnedGridPoint),
    pinnedGridPoint,
  };
}

/** Clear the pin without moving the linked slices away from their last point. */
export function clearPinnedPoint(state: ViewerState): ViewerState {
  if (state.pinnedGridPoint === null) {
    return state;
  }
  return {
    ...state,
    pinnedGridPoint: null,
  };
}

/** Switch the active 3D plane while retaining every axis' linked slice index. */
export function setActiveAxis(state: ViewerState, activeAxis: LogicalAxis): ViewerState {
  if (state.activeAxis === activeAxis) {
    return state;
  }
  return {
    ...state,
    activeAxis,
  };
}

/** Move one slice. If a point is pinned, move that point along the same axis too. */
export function setSliceIndex(
  state: ViewerState,
  axis: LogicalAxis,
  index: number,
  logicalShape: Shape3,
): ViewerState {
  assertLogicalShape(logicalShape);
  const nextIndex = clampIndex(index, logicalShape[AXIS_INDEX[axis]]);
  const sliceIndices = {
    ...state.sliceIndices,
    [axis]: nextIndex,
  };
  const pinnedGridPoint = state.pinnedGridPoint === null
    ? null
    : pointFromSliceIndices(sliceIndices);
  return {
    ...state,
    sliceIndices,
    pinnedGridPoint,
  };
}

/** Clamp linked slices and any pin after changing to a different logical shape. */
export function reconcileViewerState(
  state: ViewerState,
  logicalShape: Shape3,
): ViewerState {
  assertLogicalShape(logicalShape);
  if (state.pinnedGridPoint !== null) {
    const pinnedGridPoint = clampGridPoint(state.pinnedGridPoint, logicalShape);
    return {
      ...state,
      sliceIndices: sliceIndicesFromPoint(pinnedGridPoint),
      pinnedGridPoint,
    };
  }

  return {
    ...state,
    sliceIndices: {
      x: clampIndex(state.sliceIndices.x, logicalShape[0]),
      y: clampIndex(state.sliceIndices.y, logicalShape[1]),
      z: clampIndex(state.sliceIndices.z, logicalShape[2]),
    },
  };
}

export function activeSliceIndex(state: ViewerState): number {
  return state.sliceIndices[state.activeAxis];
}

function clampGridPoint(point: Index3, logicalShape: Shape3): Index3 {
  assertLogicalShape(logicalShape);
  return [
    clampIndex(point[0], logicalShape[0]),
    clampIndex(point[1], logicalShape[1]),
    clampIndex(point[2], logicalShape[2]),
  ];
}

function clampIndex(index: number, dimension: number): number {
  const rounded = Number.isFinite(index) ? Math.round(index) : 0;
  return Math.min(dimension - 1, Math.max(0, rounded));
}

function sliceIndicesFromPoint(point: Index3): SliceIndices {
  return {
    x: point[0],
    y: point[1],
    z: point[2],
  };
}

function pointFromSliceIndices(indices: SliceIndices): Index3 {
  return [indices.x, indices.y, indices.z];
}

function assertLogicalShape(shape: Shape3): void {
  if (shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
    throw new RangeError(`Logical shape must contain three positive integers; got [${shape.join(", ")}].`);
  }
}
