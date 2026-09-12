import type { NpyArray3D, NpyNumericArray } from "./field-model.ts";

interface NpyHeader {
  descr: string;
  fortranOrder: boolean;
  shape: number[];
  dataOffset: number;
}

const latin1Decoder = new TextDecoder("latin1");
const utf8Decoder = new TextDecoder("utf-8");
const HOST_IS_LITTLE_ENDIAN = (() => {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 256, true);
  return new Uint16Array(buffer)[0] === 256;
})();

/** Rounds a numeric metadata value exactly as the declared NumPy float dtype stores it. */
export function normalizeNumericValueForNpyDtype(value: number, dtype: string): number {
  const match = /^[<>=|]?f(2|4|8)$/.exec(dtype.trim().toLowerCase());
  if (!match || !Number.isFinite(value)) {
    return value;
  }
  if (match[1] === "2") {
    return halfToFloat(floatToHalf(value));
  }
  return match[1] === "4" ? Math.fround(value) : value;
}

export function parseNpy(buffer: ArrayBuffer, name: string): NpyArray3D {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || bytes[0] !== 0x93 || latin1Decoder.decode(bytes.slice(1, 6)) !== "NUMPY") {
    throw new Error(`${name} is not a valid NumPy .npy file.`);
  }

  const major = bytes[6];
  const view = new DataView(buffer);
  let headerLength = 0;
  let headerStart = 0;

  if (major === 1) {
    headerLength = view.getUint16(8, true);
    headerStart = 10;
  } else if (major === 2 || major === 3) {
    headerLength = view.getUint32(8, true);
    headerStart = 12;
  } else {
    throw new Error(`Unsupported .npy version ${major}.`);
  }

  if (headerStart + headerLength > bytes.length) {
    throw new Error("The .npy header is shorter than its declared length.");
  }
  const headerDecoder = major === 3 ? utf8Decoder : latin1Decoder;
  const headerText = headerDecoder.decode(bytes.slice(headerStart, headerStart + headerLength));
  const header = parseHeader(headerText, headerStart + headerLength);
  const elementCount = header.shape.reduce((product, dimension) => product * dimension, 1);
  const warnings: string[] = [];
  const data = decodeData(buffer, header.dataOffset, header.descr, elementCount);

  if (header.shape.length !== 3) {
    throw new Error(`Expected a 3D NumPy array, got shape (${header.shape.join(", ")}).`);
  }

  return {
    name,
    sourceShape: [header.shape[0], header.shape[1], header.shape[2]],
    data,
    dtype: header.descr,
    fortranOrder: header.fortranOrder,
    warnings,
  };
}

function parseHeader(headerText: string, dataOffset: number): NpyHeader {
  const descrMatch = /'descr'\s*:\s*'([^']+)'/.exec(headerText);
  const fortranMatch = /'fortran_order'\s*:\s*(True|False)/.exec(headerText);
  const shapeMatch = /'shape'\s*:\s*\(([^)]*)\)/.exec(headerText);

  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error("Could not parse the .npy header.");
  }

  const shape = shapeMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));

  if (shape.length === 0 || shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error("The .npy array shape is invalid.");
  }

  return {
    descr: descrMatch[1],
    fortranOrder: fortranMatch[1] === "True",
    shape,
    dataOffset,
  };
}

function decodeData(
  buffer: ArrayBuffer,
  dataOffset: number,
  descr: string,
  count: number,
): NpyNumericArray {
  const byteOrder = descr[0];
  const kind = descr[1];
  const itemSize = Number(descr.slice(2));
  const expectedBytes = count * itemSize;

  if (buffer.byteLength - dataOffset < expectedBytes) {
    throw new Error(`The .npy payload is shorter than expected for dtype ${descr}.`);
  }

  const littleEndian = byteOrder === "<" || byteOrder === "|" || (byteOrder === "=" && HOST_IS_LITTLE_ENDIAN);
  const isHalfFloat = kind === "f" && itemSize === 2;

  if (littleEndian && !isHalfFloat && itemSize !== 8) {
    switch (`${kind}${itemSize}`) {
      case "i1":
        return new Int8Array(buffer, dataOffset, count);
      case "u1":
      case "b1":
        return new Uint8Array(buffer, dataOffset, count);
      case "i2":
        return new Int16Array(buffer, dataOffset, count);
      case "u2":
        return new Uint16Array(buffer, dataOffset, count);
      case "i4":
        return new Int32Array(buffer, dataOffset, count);
      case "u4":
        return new Uint32Array(buffer, dataOffset, count);
      case "f4":
        return new Float32Array(buffer, dataOffset, count);
      default:
        break;
    }
  }

  const view = new DataView(buffer, dataOffset, expectedBytes);

  if (kind === "f" && itemSize === 2) {
    const out = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = halfToFloat(view.getUint16(index * 2, littleEndian));
    }
    return out;
  }

  if (kind === "f" && itemSize === 4) {
    const out = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = view.getFloat32(index * 4, littleEndian);
    }
    return out;
  }

  if (kind === "f" && itemSize === 8) {
    const out = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      out[index] = view.getFloat64(index * 8, littleEndian);
    }
    return out;
  }

  if ((kind === "i" || kind === "u") && itemSize === 8) {
    const out = kind === "i" ? new BigInt64Array(count) : new BigUint64Array(count);
    for (let index = 0; index < count; index += 1) {
      const value = kind === "i"
        ? view.getBigInt64(index * 8, littleEndian)
        : view.getBigUint64(index * 8, littleEndian);
      out[index] = value;
    }
    return out;
  }

  if ((kind === "i" || kind === "u" || kind === "b") && [1, 2, 4].includes(itemSize)) {
    const signed = kind === "i";
    const out = itemSize === 4
      ? signed ? new Int32Array(count) : new Uint32Array(count)
      : itemSize === 2
        ? signed ? new Int16Array(count) : new Uint16Array(count)
        : signed ? new Int8Array(count) : new Uint8Array(count);

    for (let index = 0; index < count; index += 1) {
      const offset = index * itemSize;
      if (itemSize === 1) {
        out[index] = signed ? view.getInt8(offset) : view.getUint8(offset);
      } else if (itemSize === 2) {
        out[index] = signed ? view.getInt16(offset, littleEndian) : view.getUint16(offset, littleEndian);
      } else {
        out[index] = signed ? view.getInt32(offset, littleEndian) : view.getUint32(offset, littleEndian);
      }
    }
    return out;
  }

  throw new Error(`Unsupported NumPy dtype ${descr}.`);
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;

  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 2 ** 10);
  }

  if (exponent === 31) {
    return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }

  return sign * 2 ** (exponent - 15) * (1 + fraction / 2 ** 10);
}

function floatToHalf(value: number): number {
  const buffer = new ArrayBuffer(4);
  const floatView = new Float32Array(buffer);
  const uintView = new Uint32Array(buffer);
  floatView[0] = value;
  const bits32 = uintView[0];
  let bits16 = (bits32 >>> 16) & 0x8000;
  let mantissa = (bits32 >>> 12) & 0x07ff;
  const exponent = (bits32 >>> 23) & 0xff;

  if (exponent < 103) {
    return bits16;
  }
  if (exponent > 142) {
    bits16 |= 0x7c00;
    if (exponent === 255 && (bits32 & 0x007fffff) !== 0) {
      bits16 |= 1;
    }
    return bits16;
  }
  if (exponent < 113) {
    mantissa |= 0x0800;
    bits16 |= (mantissa >>> (114 - exponent)) + ((mantissa >>> (113 - exponent)) & 1);
    return bits16;
  }
  bits16 |= ((exponent - 112) << 10) | (mantissa >>> 1);
  return bits16 + (mantissa & 1);
}
