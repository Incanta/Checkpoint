import { decode } from "koffi";

export function stringify(obj: any): string {
  return JSON.stringify(
    obj,
    (key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

export function decodeHash(obj: any, offset: number = 0): bigint {
  return decode(obj, offset * 8, "TLongtail_Hash");
}

export function decodeHashes(obj: any, count: number): bigint[] {
  const result = new Array<bigint>(count);
  for (let i = 0; i < count; i++) {
    result[i] = decodeHash(obj, i);
  }
  return result;
}
