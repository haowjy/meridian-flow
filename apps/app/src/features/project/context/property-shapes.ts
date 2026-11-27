import type { JsonValue } from "@meridian/contracts/threads";

type Scalar = string | number | boolean | null;

const isScalar = (value: JsonValue): value is Scalar => value === null || typeof value !== "object";

export function isChipList(value: JsonValue): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item !== null && isScalar(item))
  );
}

export function isEmptyValue(value: JsonValue): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}
