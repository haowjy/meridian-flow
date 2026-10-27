/** Which way a property value is shown: chips, a word, or the source it was written in. */
import type { JsonValue } from "@meridian/contracts/threads";

type Scalar = string | number | boolean | null;

const isScalar = (value: JsonValue): value is Scalar => value === null || typeof value !== "object";

/** A list the block shows as chips: every item is a string, number or boolean. */
export function isChipList(value: JsonValue): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => item !== null && isScalar(item))
  );
}

/** Nothing to show: null, an empty string, or an empty list or map. */
export function isEmptyValue(value: JsonValue): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}
