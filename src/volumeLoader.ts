import { unzipSync } from "fflate";
import type { NumericArray, VolumeData } from "./types";

interface NpyHeader {
  descr: string;
  fortranOrder: boolean;
  shape: number[];
  dataOffset: number;
}

const decoder = new TextDecoder("latin1");

export async function loadVolumeFile(file: File): Promise<VolumeData[]> {
  const buffer = await file.arrayBuffer();
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".npy")) {
    return [parseNpy(buffer, file.name)];
  }

  if (lowerName.endsWith(".npz")) {
    const entries = unzipSync(new Uint8Array(buffer));
    const parsed: VolumeData[] = [];

    for (const [name, bytes] of Object.entries(entries)) {
      if (!name.toLowerCase().endsWith(".npy")) {
        continue;
      }

      parsed.push(parseNpy(sliceBytes(bytes), name.replace(/\.npy$/i, "")));
    }

    if (parsed.length === 0) {
      throw new Error("No .npy arrays were found inside the .npz file.");
    }

    const synthesized = synthesizePipelineLabels(parsed);
    const volumes = synthesized ? [synthesized, ...parsed] : parsed;
    return volumes.sort((a, b) => scoreArrayName(b.name) - scoreArrayName(a.name));
  }

  throw new Error("Unsupported volume format. Use .npy or .npz.");
}

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
  const dataBytes = bytes.slice(header.dataOffset);
  const warnings: string[] = [];
  const data = decodeData(dataBytes, header.descr, elementCount, warnings);
  const shape = toShape3(header.shape, warnings);

  return {
    name,
    shape,
    sourceShape: header.shape,
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

function decodeData(bytes: Uint8Array, descr: string, count: number, warnings: string[]): NumericArray {
  const byteOrder = descr[0];
  const kind = descr[1];
  const itemSize = Number(descr.slice(2));
  const expectedBytes = count * itemSize;

  if (bytes.byteLength < expectedBytes) {
    throw new Error(`The .npy payload is shorter than expected for dtype ${descr}.`);
  }

  const littleEndian = byteOrder === "<" || byteOrder === "|" || (byteOrder === "=" && isLittleEndianHost());
  const source = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer.slice(0, expectedBytes)
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + expectedBytes);

  if (littleEndian && kind !== "f2" && itemSize !== 8) {
    switch (`${kind}${itemSize}`) {
      case "i1":
        return new Int8Array(source);
      case "u1":
      case "b1":
        return new Uint8Array(source);
      case "i2":
        return new Int16Array(source);
      case "u2":
        return new Uint16Array(source);
      case "i4":
        return new Int32Array(source);
      case "u4":
        return new Uint32Array(source);
      case "f4":
        return new Float32Array(source);
      default:
        break;
    }
  }

  const view = new DataView(source);

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

function toShape3(shape: number[], warnings: string[]): [number, number, number] {
  let normalized = [...shape];

  while (normalized.length > 3) {
    const singletonIndex = normalized.findIndex((dimension) => dimension === 1);
    if (singletonIndex === -1) {
      break;
    }
    normalized.splice(singletonIndex, 1);
  }

  if (normalized.length === 2) {
    warnings.push("A 2D array was loaded as a single z slice.");
    normalized = [normalized[0], normalized[1], 1];
  }

  if (normalized.length !== 3) {
    throw new Error(`Expected a 3D volume, got shape (${shape.join(", ")}).`);
  }

  return [normalized[0], normalized[1], normalized[2]];
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

function isLittleEndianHost(): boolean {
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setUint16(0, 256, true);
  return new Uint16Array(buffer)[0] === 256;
}

function sliceBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function scoreArrayName(name: string): number {
  const lower = name.toLowerCase();
  let score = 0;
  if (lower.includes("pipeline_labels") || lower.includes("semantic_labels")) {
    score += 10;
  }
  if (lower === "labels" || lower.endsWith("/labels")) {
    score += 8;
  }
  if (lower.includes("label")) {
    score += 5;
  }
  if (lower.includes("volume")) {
    score += 3;
  }
  if (lower.includes("ccl")) {
    score += 2;
  }
  if (lower.includes("case")) {
    score += 1;
  }
  return score;
}

function synthesizePipelineLabels(volumes: VolumeData[]): VolumeData | null {
  const byName = new Map(volumes.map((volume) => [normalizeArrayName(volume.name), volume]));
  const outside = byName.get("outside");
  if (!outside) {
    return null;
  }

  const inside = byName.get("inside") ?? null;
  const band = byName.get("band") ?? null;
  const surfaceBarrier = byName.get("surface_barrier") ?? byName.get("surface-barrier") ?? null;
  const candidates = [inside, band, surfaceBarrier].filter((volume): volume is VolumeData => Boolean(volume));

  for (const candidate of candidates) {
    if (!sameShape(candidate.shape, outside.shape)) {
      throw new Error(`Cannot synthesize labels: ${candidate.name} has shape ${candidate.shape.join(" x ")}, expected ${outside.shape.join(" x ")}.`);
    }
  }

  const [nx, ny, nz] = outside.shape;
  const labels = new Uint8Array(nx * ny * nz);

  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        const offset = k + nz * (j + ny * i);
        const isOutside = Boolean(getVolumeValue(outside, i, j, k));
        const isInside = inside ? Boolean(getVolumeValue(inside, i, j, k)) : !isOutside;

        if (isInside) {
          labels[offset] = 2;
        }
        if (isOutside) {
          labels[offset] = 1;
        }
        if (band && Boolean(getVolumeValue(band, i, j, k))) {
          labels[offset] = 3;
        }
        if (surfaceBarrier && Boolean(getVolumeValue(surfaceBarrier, i, j, k))) {
          labels[offset] = 4;
        }
      }
    }
  }

  return {
    name: "pipeline_labels",
    shape: outside.shape,
    sourceShape: outside.sourceShape,
    data: labels,
    dtype: "|u1",
    fortranOrder: false,
    warnings: [
      "Synthesized from outside/inside/band/surface_barrier masks using labels 0 unknown, 1 outside, 2 inside, 3 band, 4 surface barrier.",
    ],
  };
}

function normalizeArrayName(name: string): string {
  return name
    .split("/")
    .pop()
    ?.replace(/\.npy$/i, "")
    .toLowerCase() ?? name.toLowerCase();
}

function sameShape(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function getVolumeValue(volume: VolumeData, i: number, j: number, k: number): number {
  const [nx, ny, nz] = volume.shape;
  const offset = volume.fortranOrder
    ? i + nx * (j + ny * k)
    : k + nz * (j + ny * i);
  return Number(volume.data[offset]);
}
