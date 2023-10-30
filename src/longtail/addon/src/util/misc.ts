export function stringify(obj: any): string {
  return JSON.stringify(
    obj,
    (key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
