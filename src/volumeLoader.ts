import {
  type NumericArray,
  type VolumeData,
  type VolumeVisualization,
} from "./types";

interface NpyHeader {
  descr: string;
  fortranOrder: boolean;
  shape: number[];
  dataOffset: number;
}

const decoder = new TextDecoder("latin1");
const HOST_IS_LITTLE_ENDIAN = (() => {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 256, true);
  return new Uint16Array(buffer)[0] === 256;
})();

export function parseNpy(buffer: ArrayBuffer, name: string): VolumeData {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12 || bytes[0] !== 0x93 || decoder.decode(bytes.slice(1, 6)) !== "NUMPY") {
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

  const headerText = decoder.decode(bytes.slice(headerStart, headerStart + headerLength));
  const header = parseHeader(headerText, headerStart + headerLength);
  const elementCount = header.shape.reduce((product, dimension) => product * dimension, 1);
  const warnings: string[] = [];
  const data = decodeData(buffer, header.dataOffset, header.descr, elementCount, warnings);
  const baseName = name
    .split("/")
    .pop()
    ?.replace(/\.npy$/i, "")
    .toLowerCase() ?? name.toLowerCase();
  let visualization: VolumeVisualization;

  if (
    /^\d{3}_final_ccl_labels$/.test(baseName)
    || /^\d{3}_inside_filtered_labels$/.test(baseName)
    || /^\d{3}_boundary_voted_labels$/.test(baseName)
  ) {
    visualization = "pipelineLabels";
  } else if (/^\d{3}_final_ccl_components$/.test(baseName)) {
    visualization = "finalCclComponents";
  } else if (/^\d{3}_final_ccl_cases$/.test(baseName)) {
    visualization = "finalCclCases";
  } else {
    throw new Error(
      `${name} is not a supported pipeline debug volume. Expected NNN_final_ccl_labels.npy, NNN_final_ccl_components.npy, NNN_final_ccl_cases.npy, MMM_inside_filtered_labels.npy, or KKK_boundary_voted_labels.npy.`,
    );
  }

  if (header.shape.length !== 3) {
    throw new Error(`Expected a 3D pipeline volume, got shape (${header.shape.join(", ")}).`);
  }

  return {
    name,
    shape: [header.shape[0], header.shape[1], header.shape[2]],
    sourceShape: header.shape,
    data,
    dtype: header.descr,
    fortranOrder: header.fortranOrder,
    warnings,
    visualization,
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
  warnings: string[],
): NumericArray {
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
    const out = new Float64Array(count);
    let unsafe = false;
    for (let index = 0; index < count; index += 1) {
      const value = kind === "i"
        ? view.getBigInt64(index * 8, littleEndian)
        : view.getBigUint64(index * 8, littleEndian);
      const asNumber = Number(value);
      if (!Number.isSafeInteger(asNumber)) {
        unsafe = true;
      }
      out[index] = asNumber;
    }
    if (unsafe) {
      warnings.push("One or more 64-bit labels exceeded JavaScript's safe integer range.");
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
