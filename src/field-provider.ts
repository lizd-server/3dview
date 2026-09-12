import {
  type DenseField,
  type FieldValue,
  type Index3,
  type LogicalAxis,
  type NpyNumericArray,
  type ResolvedFieldDefinition,
  type Shape3,
  type WorldPoint3,
} from "./field-model.ts";
import {
  sampleNpyValue,
  sliceCoordinatesToLogicalIndex,
  sliceDimensions,
  slicePlaneAxes,
  sourceShapeToLogicalShape,
  transformIndexToWorld,
} from "./grid-field.ts";

export type FieldFidelity = "exact" | "preview";

export interface FieldSliceRequest {
  axis: LogicalAxis;
  index: number;
}

/**
 * An exact slice in logical grid order.
 *
 * Values are row-major (`v * width + u`). Both coordinates increase along
 * `planeAxes`; canvas-style vertical inversion belongs in the view layer.
 */
export interface FieldSlice {
  axis: LogicalAxis;
  index: number;
  planeAxes: readonly [LogicalAxis, LogicalAxis];
  shape: [number, number];
  values: NpyNumericArray;
  fidelity: "exact";
}

export interface FieldSample {
  index: [number, number, number];
  world: WorldPoint3;
  value: FieldValue;
  fidelity: "exact";
}

/** Async from the start so an HTTP- or worker-backed provider can replace it. */
export interface FieldProvider {
  readonly definition: ResolvedFieldDefinition;
  readonly dtype: string;

  readSlice(request: FieldSliceRequest, signal?: AbortSignal): Promise<FieldSlice>;
  readPoint(index: Index3, signal?: AbortSignal): Promise<FieldSample>;
}

export class InMemoryFieldProvider implements FieldProvider {
  readonly definition: ResolvedFieldDefinition;
  readonly dtype: string;

  private readonly field: DenseField;

  constructor(field: DenseField) {
    const logicalShape = sourceShapeToLogicalShape(
      field.array.sourceShape,
      field.definition.sourceAxisOrder,
    );
    if (!sameShape(logicalShape, field.definition.logicalShape)) {
      throw new Error(
        `Field logical shape [${field.definition.logicalShape.join(", ")}] does not match `
        + `source shape [${field.array.sourceShape.join(", ")}] with axis order `
        + `[${field.definition.sourceAxisOrder.join(", ")}].`,
      );
    }

    const expectedLength = field.array.sourceShape.reduce(
      (product, dimension) => product * dimension,
      1,
    );
    if (field.array.data.length !== expectedLength) {
      throw new Error(
        `Field data contains ${field.array.data.length} values; expected ${expectedLength} `
        + `for shape [${field.array.sourceShape.join(", ")}].`,
      );
    }

    this.field = field;
    this.definition = field.definition;
    this.dtype = field.array.dtype;
  }

  async readSlice(request: FieldSliceRequest, signal?: AbortSignal): Promise<FieldSlice> {
    signal?.throwIfAborted();

    const { axis, index } = request;
    const logicalShape = this.definition.logicalShape;
    const [width, height] = sliceDimensions(logicalShape, axis);
    // The coordinate helper performs the slice-index bounds check even when a
    // dimension is empty in the future; current regular grids are positive.
    sliceCoordinatesToLogicalIndex(logicalShape, axis, index, 0, 0);

    const values = createTypedArrayLike(this.field.array.data, width * height);
    for (let v = 0; v < height; v += 1) {
      signal?.throwIfAborted();
      for (let u = 0; u < width; u += 1) {
        const logicalIndex = sliceCoordinatesToLogicalIndex(
          logicalShape,
          axis,
          index,
          u,
          v,
        );
        setFieldValue(
          values,
          v * width + u,
          sampleNpyValue(
            this.field.array,
            logicalIndex,
            this.definition.sourceAxisOrder,
          ),
        );
      }
    }

    signal?.throwIfAborted();
    return {
      axis,
      index,
      planeAxes: slicePlaneAxes(axis),
      shape: [width, height],
      values,
      fidelity: "exact",
    };
  }

  async readPoint(index: Index3, signal?: AbortSignal): Promise<FieldSample> {
    signal?.throwIfAborted();
    const value = sampleNpyValue(
      this.field.array,
      index,
      this.definition.sourceAxisOrder,
    );
    signal?.throwIfAborted();
    return {
      index: [index[0], index[1], index[2]],
      world: transformIndexToWorld(index, this.definition.indexToWorld),
      value,
      fidelity: "exact",
    };
  }
}

interface NpyNumericArrayConstructor {
  new(length: number): NpyNumericArray;
}

function createTypedArrayLike(source: NpyNumericArray, length: number): NpyNumericArray {
  const Constructor = source.constructor as NpyNumericArrayConstructor;
  return new Constructor(length);
}

function setFieldValue(target: NpyNumericArray, index: number, value: FieldValue): void {
  if (target instanceof BigInt64Array || target instanceof BigUint64Array) {
    if (typeof value !== "bigint") {
      throw new TypeError("A BigInt field produced a numeric sample.");
    }
    target[index] = value;
    return;
  }
  if (typeof value !== "number") {
    throw new TypeError("A numeric field produced a BigInt sample.");
  }
  target[index] = value;
}

function sameShape(left: Shape3, right: Shape3): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}
