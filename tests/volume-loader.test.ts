import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNumericValueForNpyDtype, parseNpy } from "../src/volumeLoader.ts";

test("normalizes numeric metadata values to NumPy float storage precision", () => {
  assert.equal(normalizeNumericValueForNpyDtype(0.1, "<f4"), Math.fround(0.1));
  assert.equal(normalizeNumericValueForNpyDtype(0.1, "<f2"), 0.0999755859375);
  assert.equal(normalizeNumericValueForNpyDtype(0.1, "<f8"), 0.1);
});

test("parseNpy accepts an arbitrary 3D filename", () => {
  const payload = new Float32Array([1.5, -2, 3, 4]);
  const parsed = parseNpy(makeNpy("<f4", [1, 2, 2], false, bytesOf(payload)), "my_new_algorithm.npy");

  assert.equal(parsed.name, "my_new_algorithm.npy");
  assert.deepEqual(parsed.sourceShape, [1, 2, 2]);
  assert.equal(parsed.dtype, "<f4");
  assert.deepEqual(Array.from(parsed.data), [1.5, -2, 3, 4]);
});

test("parseNpy preserves distinct uint64 labels beyond Number.MAX_SAFE_INTEGER", () => {
  const payload = new ArrayBuffer(16);
  const view = new DataView(payload);
  view.setBigUint64(0, 9_007_199_254_740_992n, true);
  view.setBigUint64(8, 9_007_199_254_740_993n, true);

  const parsed = parseNpy(makeNpy("<u8", [1, 1, 2], false, new Uint8Array(payload)), "ids.npy");

  assert.ok(parsed.data instanceof BigUint64Array);
  assert.equal(parsed.data[0], 9_007_199_254_740_992n);
  assert.equal(parsed.data[1], 9_007_199_254_740_993n);
});

test("parseNpy preserves signed int64 labels", () => {
  const payload = new ArrayBuffer(16);
  const view = new DataView(payload);
  view.setBigInt64(0, -9_007_199_254_740_993n, false);
  view.setBigInt64(8, 17n, false);

  const parsed = parseNpy(makeNpy(">i8", [1, 1, 2], false, new Uint8Array(payload)), "signed.npy");

  assert.ok(parsed.data instanceof BigInt64Array);
  assert.deepEqual(Array.from(parsed.data), [-9_007_199_254_740_993n, 17n]);
});

test("parseNpy still requires a three-dimensional array", () => {
  const buffer = makeNpy("|u1", [2, 2], false, new Uint8Array(4));
  assert.throws(() => parseNpy(buffer, "flat.npy"), /Expected a 3D NumPy array/);
});

function makeNpy(
  descr: string,
  shape: number[],
  fortranOrder: boolean,
  payload: Uint8Array,
): ArrayBuffer {
  const shapeText = shape.length === 1 ? `${shape[0]},` : shape.join(", ");
  const headerBody = `{'descr': '${descr}', 'fortran_order': ${fortranOrder ? "True" : "False"}, 'shape': (${shapeText}), }`;
  const preambleBytes = 10;
  const padding = (16 - ((preambleBytes + headerBody.length + 1) % 16)) % 16;
  const header = new TextEncoder().encode(`${headerBody}${" ".repeat(padding)}\n`);
  const result = new Uint8Array(preambleBytes + header.length + payload.length);
  result.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);
  new DataView(result.buffer).setUint16(8, header.length, true);
  result.set(header, preambleBytes);
  result.set(payload, preambleBytes + header.length);
  return result.buffer;
}

function bytesOf(array: ArrayBufferView): Uint8Array {
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}
