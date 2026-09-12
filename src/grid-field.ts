import type {
  CoordinatePreset,
  FieldValue,
  GridAssociation,
  Index3,
  LogicalAxis,
  Matrix4,
  NpyArray3D,
  Shape3,
  SourceAxisOrder,
  WorldPoint3,
} from "./field-model.ts";

export const XYZ_SOURCE_AXIS_ORDER: SourceAxisOrder = ["x", "y", "z"];

export function logicalAxisIndex(axis: LogicalAxis): 0 | 1 | 2 {
  if (axis === "x") {
    return 0;
  }
  if (axis === "y") {
    return 1;
  }
  return 2;
}

export function isSourceAxisOrder(value: unknown): value is SourceAxisOrder {
  return Array.isArray(value)
    && value.length === 3
    && value.every((axis) => axis === "x" || axis === "y" || axis === "z")
    && new Set(value).size === 3;
}

export function sourceShapeToLogicalShape(
  sourceShape: Shape3,
  sourceAxisOrder: SourceAxisOrder,
): [number, number, number] {
  assertShape(sourceShape);
  assertSourceAxisOrder(sourceAxisOrder);
  const logicalShape: [number, number, number] = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    logicalShape[logicalAxisIndex(sourceAxisOrder[sourceAxis])] = sourceShape[sourceAxis];
  }
  return logicalShape;
}

export function logicalToSourceIndex(
  logicalIndex: Index3,
  sourceAxisOrder: SourceAxisOrder,
): [number, number, number] {
  assertSourceAxisOrder(sourceAxisOrder);
  return sourceAxisOrder.map((axis) => logicalIndex[logicalAxisIndex(axis)]) as [number, number, number];
}

export function sourceToLogicalIndex(
  sourceIndex: Index3,
  sourceAxisOrder: SourceAxisOrder,
): [number, number, number] {
  assertSourceAxisOrder(sourceAxisOrder);
  const logicalIndex: [number, number, number] = [0, 0, 0];
  for (let sourceAxis = 0; sourceAxis < 3; sourceAxis += 1) {
    logicalIndex[logicalAxisIndex(sourceAxisOrder[sourceAxis])] = sourceIndex[sourceAxis];
  }
  return logicalIndex;
}

export function sourceLinearOffset(
  sourceIndex: Index3,
  sourceShape: Shape3,
  fortranOrder: boolean,
): number {
  assertShape(sourceShape);
  for (let axis = 0; axis < 3; axis += 1) {
    const index = sourceIndex[axis];
    if (!Number.isInteger(index) || index < 0 || index >= sourceShape[axis]) {
      throw new RangeError(`Source index [${sourceIndex.join(", ")}] is outside shape [${sourceShape.join(", ")}].`);
    }
  }

  const [i, j, k] = sourceIndex;
  const [ni, nj, nk] = sourceShape;
  return fortranOrder
    ? i + ni * (j + nj * k)
    : k + nk * (j + nj * i);
}

export function sampleNpyValue(
  array: NpyArray3D,
  logicalIndex: Index3,
  sourceAxisOrder: SourceAxisOrder,
): FieldValue {
  const logicalShape = sourceShapeToLogicalShape(array.sourceShape, sourceAxisOrder);
  for (let axis = 0; axis < 3; axis += 1) {
    const index = logicalIndex[axis];
    if (!Number.isInteger(index) || index < 0 || index >= logicalShape[axis]) {
      throw new RangeError(`Logical index [${logicalIndex.join(", ")}] is outside shape [${logicalShape.join(", ")}].`);
    }
  }
  const sourceIndex = logicalToSourceIndex(logicalIndex, sourceAxisOrder);
  const offset = sourceLinearOffset(sourceIndex, array.sourceShape, array.fortranOrder);
  return array.data[offset];
}

export function sliceDimensions(
  logicalShape: Shape3,
  axis: LogicalAxis,
): [number, number] {
  assertShape(logicalShape);
  if (axis === "x") {
    return [logicalShape[2], logicalShape[1]];
  }
  if (axis === "y") {
    return [logicalShape[0], logicalShape[2]];
  }
  return [logicalShape[0], logicalShape[1]];
}

export function slicePlaneAxes(axis: LogicalAxis): readonly [LogicalAxis, LogicalAxis] {
  if (axis === "x") {
    return ["z", "y"];
  }
  if (axis === "y") {
    return ["x", "z"];
  }
  return ["x", "y"];
}

/** Maps slice coordinates whose u/v values increase along slicePlaneAxes. */
export function sliceCoordinatesToLogicalIndex(
  logicalShape: Shape3,
  axis: LogicalAxis,
  sliceIndex: number,
  u: number,
  v: number,
): [number, number, number] {
  assertShape(logicalShape);
  const axisIndex = logicalAxisIndex(axis);
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= logicalShape[axisIndex]) {
    throw new RangeError(`Slice index ${sliceIndex} is outside ${axis.toUpperCase()} dimension ${logicalShape[axisIndex]}.`);
  }
  const [width, height] = sliceDimensions(logicalShape, axis);
  if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= width || v >= height) {
    throw new RangeError(`Slice coordinate [${u}, ${v}] is outside ${width} x ${height}.`);
  }
  if (axis === "x") {
    return [sliceIndex, v, u];
  }
  if (axis === "y") {
    return [u, sliceIndex, v];
  }
  return [u, v, sliceIndex];
}

/** Maps a top-left-origin canvas pixel to an exact logical XYZ sample index. */
export function slicePixelToLogicalIndex(
  logicalShape: Shape3,
  axis: LogicalAxis,
  sliceIndex: number,
  pixelX: number,
  pixelY: number,
): [number, number, number] {
  assertShape(logicalShape);
  const axisIndex = logicalAxisIndex(axis);
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= logicalShape[axisIndex]) {
    throw new RangeError(`Slice index ${sliceIndex} is outside ${axis.toUpperCase()} dimension ${logicalShape[axisIndex]}.`);
  }
  const [width, height] = sliceDimensions(logicalShape, axis);
  if (
    !Number.isInteger(pixelX)
    || !Number.isInteger(pixelY)
    || pixelX < 0
    || pixelY < 0
    || pixelX >= width
    || pixelY >= height
  ) {
    throw new RangeError(`Slice pixel [${pixelX}, ${pixelY}] is outside ${width} x ${height}.`);
  }
  return sliceCoordinatesToLogicalIndex(logicalShape, axis, sliceIndex, pixelX, height - 1 - pixelY);
}

export function createPresetIndexToWorld(
  preset: CoordinatePreset,
  logicalShape: Shape3,
  association: GridAssociation,
): Matrix4 {
  assertShape(logicalShape);
  const scales: [number, number, number] = [0, 0, 0];
  const origins: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis += 1) {
    const dimension = logicalShape[axis];
    if (preset === "index") {
      scales[axis] = 1;
      origins[axis] = association === "cell" ? 0.5 : 0;
    } else if (association === "cell") {
      scales[axis] = 2 / dimension;
      origins[axis] = -1 + scales[axis] / 2;
    } else if (dimension === 1) {
      scales[axis] = 0;
      origins[axis] = 0;
    } else {
      scales[axis] = 2 / (dimension - 1);
      origins[axis] = -1;
    }
  }

  return [
    scales[0], 0, 0, origins[0],
    0, scales[1], 0, origins[1],
    0, 0, scales[2], origins[2],
    0, 0, 0, 1,
  ];
}

export function transformIndexToWorld(index: Index3, matrix: Matrix4): WorldPoint3 {
  assertIndexToWorld(matrix);
  const [x, y, z] = index;
  const tx = matrix[0] * x + matrix[1] * y + matrix[2] * z + matrix[3];
  const ty = matrix[4] * x + matrix[5] * y + matrix[6] * z + matrix[7];
  const tz = matrix[8] * x + matrix[9] * y + matrix[10] * z + matrix[11];
  const tw = matrix[12] * x + matrix[13] * y + matrix[14] * z + matrix[15];
  if (Math.abs(tw) < Number.EPSILON) {
    throw new Error("indexToWorld mapped the sample to a zero homogeneous coordinate.");
  }
  return tw === 1 ? [tx, ty, tz] : [tx / tw, ty / tw, tz / tw];
}

/** Logical index-space limits whose transformed corners bound the whole grid domain. */
export function logicalDomainLimits(
  logicalShape: Shape3,
  association: GridAssociation,
): { min: [number, number, number]; max: [number, number, number] } {
  assertShape(logicalShape);
  if (association === "cell") {
    return {
      min: [-0.5, -0.5, -0.5],
      max: [logicalShape[0] - 0.5, logicalShape[1] - 0.5, logicalShape[2] - 0.5],
    };
  }
  return {
    min: [0, 0, 0],
    max: [logicalShape[0] - 1, logicalShape[1] - 1, logicalShape[2] - 1],
  };
}

export function worldDomainCorners(
  logicalShape: Shape3,
  association: GridAssociation,
  indexToWorld: Matrix4,
): WorldPoint3[] {
  const { min, max } = logicalDomainLimits(logicalShape, association);
  const corners: WorldPoint3[] = [];
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        corners.push(transformIndexToWorld([x, y, z], indexToWorld));
      }
    }
  }
  return corners;
}

export interface TransformedSlicePlaneFrame {
  /** World-space center of the requested logical slice. */
  center: WorldPoint3;
  /** World-space half-width vector along the slice's increasing U axis. */
  basisU: WorldPoint3;
  /** World-space half-height vector along the slice's increasing V axis. */
  basisV: WorldPoint3;
  /** Unit plane normal oriented away from the increasing sliced axis. */
  normal: WorldPoint3;
}

/**
 * Builds the world-space frame used to display and clip an exact grid slice.
 *
 * Point-sampled singleton dimensions have no mathematical domain extent. For
 * display, they receive a one-sample footprint from the corresponding affine
 * axis step. If that step is also zero (as in the normalized singleton preset),
 * the smallest available sample spacing and an independent direction are used.
 */
export function computeTransformedSlicePlaneFrame(
  logicalShape: Shape3,
  association: GridAssociation,
  indexToWorld: Matrix4,
  axis: LogicalAxis,
  sliceIndex: number,
): TransformedSlicePlaneFrame {
  assertShape(logicalShape);
  assertIndexToWorld(indexToWorld);
  const axisIndex = logicalAxisIndex(axis);
  if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= logicalShape[axisIndex]) {
    throw new RangeError(`Slice index ${sliceIndex} is outside ${axis.toUpperCase()} dimension ${logicalShape[axisIndex]}.`);
  }

  const { min, max } = logicalDomainLimits(logicalShape, association);
  const [uAxis, vAxis] = slicePlaneAxes(axis).map(logicalAxisIndex) as [0 | 1 | 2, 0 | 1 | 2];
  const centerIndex: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  centerIndex[axisIndex] = sliceIndex;

  const center = transformIndexToWorld(centerIndex, indexToWorld);
  let basisU = transformedDomainHalfAxis(centerIndex, uAxis, min[uAxis], max[uAxis], indexToWorld);
  let basisV = transformedDomainHalfAxis(centerIndex, vAxis, min[vAxis], max[vAxis], indexToWorld);

  const affineAxes = [0, 1, 2].map((index) => affineAxisVector(indexToWorld, index as 0 | 1 | 2));
  const affineScale = Math.max(...affineAxes.map(vectorLength));
  const vectorTolerance = Math.max(Number.MIN_VALUE, affineScale * 1e-12);
  const availableSpacings = affineAxes.map(vectorLength).filter((length) => length > vectorTolerance);
  const fallbackHalfExtent = availableSpacings.length > 0
    ? Math.min(...availableSpacings) / 2
    : 0.5;

  if (!isUsableVector(basisU, vectorTolerance)) {
    basisU = singleSampleHalfBasis(
      affineAxes[uAxis],
      uAxis,
      isUsableVector(basisV, vectorTolerance) ? basisV : null,
      fallbackHalfExtent,
      vectorTolerance,
    );
  }
  if (!isUsableVector(basisV, vectorTolerance)) {
    basisV = singleSampleHalfBasis(affineAxes[vAxis], vAxis, basisU, fallbackHalfExtent, vectorTolerance);
  }

  let normalVector = crossVector(basisU, basisV);
  if (!vectorsAreIndependent(basisU, basisV)) {
    const repairedLength = Math.max(vectorLength(basisV), fallbackHalfExtent);
    basisV = scaleVector(independentUnitDirection(affineAxes[vAxis], vAxis, basisU), repairedLength);
    normalVector = crossVector(basisU, basisV);
  }
  if (!isUsableVector(normalVector, vectorTolerance)) {
    // This can only occur for an entirely collapsed or numerically extreme
    // affine transform. A final canonical repair keeps the display frame valid.
    basisU = scaleVector(canonicalAxisVector(uAxis), fallbackHalfExtent);
    basisV = scaleVector(canonicalAxisVector(vAxis), fallbackHalfExtent);
    normalVector = crossVector(basisU, basisV);
  }

  let normal = normalizeVector(normalVector);
  const axisDirection = inferredPositiveAxisDirection(axisIndex, affineAxes, vectorTolerance);
  if (dotVector(normal, axisDirection) > 0) {
    normal = scaleVector(normal, -1);
  }

  return { center, basisU, basisV, normal };
}

function singleSampleHalfBasis(
  affineAxis: WorldPoint3,
  logicalAxis: 0 | 1 | 2,
  reference: WorldPoint3 | null,
  fallbackHalfExtent: number,
  tolerance: number,
): [number, number, number] {
  if (
    isUsableVector(affineAxis, tolerance)
    && (reference === null || vectorsAreIndependent(affineAxis, reference))
  ) {
    return scaleVector(affineAxis, 0.5);
  }
  return scaleVector(independentUnitDirection(affineAxis, logicalAxis, reference), fallbackHalfExtent);
}

function transformedDomainHalfAxis(
  centerIndex: [number, number, number],
  axisIndex: 0 | 1 | 2,
  minimum: number,
  maximum: number,
  indexToWorld: Matrix4,
): [number, number, number] {
  const low = [...centerIndex] as [number, number, number];
  const high = [...centerIndex] as [number, number, number];
  low[axisIndex] = minimum;
  high[axisIndex] = maximum;
  return scaleVector(subtractVector(
    transformIndexToWorld(high, indexToWorld),
    transformIndexToWorld(low, indexToWorld),
  ), 0.5);
}

function affineAxisVector(matrix: Matrix4, axisIndex: 0 | 1 | 2): [number, number, number] {
  return [matrix[axisIndex], matrix[4 + axisIndex], matrix[8 + axisIndex]];
}

function inferredPositiveAxisDirection(
  axisIndex: 0 | 1 | 2,
  affineAxes: readonly WorldPoint3[],
  tolerance: number,
): [number, number, number] {
  const direct = affineAxes[axisIndex];
  if (isUsableVector(direct, tolerance)) {
    return normalizeVector(direct);
  }
  const firstOtherAxis = ((axisIndex + 1) % 3) as 0 | 1 | 2;
  const secondOtherAxis = ((axisIndex + 2) % 3) as 0 | 1 | 2;
  const inferred = crossVector(affineAxes[firstOtherAxis], affineAxes[secondOtherAxis]);
  return isUsableVector(inferred, tolerance) ? normalizeVector(inferred) : canonicalAxisVector(axisIndex);
}

function independentUnitDirection(
  preferred: WorldPoint3,
  logicalAxis: 0 | 1 | 2,
  reference: WorldPoint3 | null,
): [number, number, number] {
  const candidates: WorldPoint3[] = [preferred, canonicalAxisVector(logicalAxis)];
  for (const axis of [0, 1, 2] as const) {
    candidates.push(canonicalAxisVector(axis));
  }

  let best: [number, number, number] = canonicalAxisVector(logicalAxis);
  let bestLength = 0;
  for (const candidate of candidates) {
    const projected = reference === null ? [...candidate] as [number, number, number] : rejectVector(candidate, reference);
    const length = vectorLength(projected);
    if (length > bestLength) {
      best = projected;
      bestLength = length;
    }
  }
  return bestLength > 0 ? scaleVector(best, 1 / bestLength) : canonicalAxisVector(logicalAxis);
}

function rejectVector(vector: WorldPoint3, reference: WorldPoint3): [number, number, number] {
  const denominator = dotVector(reference, reference);
  if (denominator === 0) {
    return [...vector] as [number, number, number];
  }
  const projectionScale = dotVector(vector, reference) / denominator;
  return subtractVector(vector, scaleVector(reference, projectionScale));
}

function canonicalAxisVector(axisIndex: 0 | 1 | 2): [number, number, number] {
  const vector: [number, number, number] = [0, 0, 0];
  vector[axisIndex] = 1;
  return vector;
}

function vectorsAreIndependent(first: WorldPoint3, second: WorldPoint3): boolean {
  const firstLength = vectorLength(first);
  const secondLength = vectorLength(second);
  if (firstLength === 0 || secondLength === 0) {
    return false;
  }
  return vectorLength(crossVector(first, second)) > firstLength * secondLength * 1e-12;
}

function isUsableVector(vector: WorldPoint3, tolerance: number): boolean {
  const length = vectorLength(vector);
  return Number.isFinite(length) && length > tolerance;
}

function vectorLength(vector: WorldPoint3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalizeVector(vector: WorldPoint3): [number, number, number] {
  return scaleVector(vector, 1 / vectorLength(vector));
}

function subtractVector(first: WorldPoint3, second: WorldPoint3): [number, number, number] {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

function scaleVector(vector: WorldPoint3, scale: number): [number, number, number] {
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale];
}

function dotVector(first: WorldPoint3, second: WorldPoint3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

function crossVector(first: WorldPoint3, second: WorldPoint3): [number, number, number] {
  return [
    first[1] * second[2] - first[2] * second[1],
    first[2] * second[0] - first[0] * second[2],
    first[0] * second[1] - first[1] * second[0],
  ];
}

export function assertIndexToWorld(value: readonly number[]): asserts value is Matrix4 {
  if (value.length !== 16 || value.some((entry) => !Number.isFinite(entry))) {
    throw new Error("indexToWorld must contain 16 finite row-major numbers.");
  }
  const tolerance = 1e-12;
  if (
    Math.abs(value[12]) > tolerance
    || Math.abs(value[13]) > tolerance
    || Math.abs(value[14]) > tolerance
    || Math.abs(value[15] - 1) > tolerance
  ) {
    throw new Error("indexToWorld must be affine with final row [0, 0, 0, 1].");
  }
}

/** Locale-independent text representation which preserves each matrix number. */
export function formatIndexToWorldText(matrix: Matrix4): string {
  assertIndexToWorld(matrix);
  return [0, 4, 8, 12]
    .map((start) => matrix.slice(start, start + 4).map((value) => value.toString()).join(" "))
    .join("\n");
}

export function parseIndexToWorldText(text: string): Matrix4 {
  const values = text.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
  if (values.length !== 16 || values.some((entry) => !Number.isFinite(entry))) {
    throw new Error("Custom indexToWorld must contain 16 finite row-major numbers.");
  }
  assertIndexToWorld(values);
  return values as unknown as Matrix4;
}

function assertSourceAxisOrder(value: SourceAxisOrder): void {
  if (!isSourceAxisOrder(value)) {
    throw new Error("sourceAxisOrder must be a permutation of x, y, and z.");
  }
}

function assertShape(shape: Shape3): void {
  if (shape.length !== 3 || shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`Expected a positive three-dimensional shape, got [${shape.join(", ")}].`);
  }
}
