/**
 * Shows a property value that is a map or a list of maps as block YAML. It is
 * for reading only; the stored text stays the authority.
 */
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

// Plain YAML scalars that would read back as another type or as syntax.
const NEEDS_QUOTES =
  /^(?:[-?:,[\]{}#&*!|>'"%@`\s]|(?:true|false|null|yes|no|~)$|[\d.+-]+$)|[:#]\s|\s$|\n/i;

function scalar(value: Scalar): string {
  if (typeof value !== "string") return String(value);
  return value === "" || NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value;
}

function lines(value: JsonValue, indent: string): string[] {
  if (isScalar(value)) return [`${indent}${scalar(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    return value.flatMap((item) => {
      if (isScalar(item)) return [`${indent}- ${scalar(item)}`];
      const inner = lines(item, `${indent}  `);
      // The first line of a nested item shares the dash.
      return [`${indent}- ${inner[0]?.trimStart() ?? ""}`, ...inner.slice(1)];
    });
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return [`${indent}{}`];
  return keys.flatMap((key) => {
    const item = value[key] as JsonValue;
    if (isScalar(item) || isEmptyValue(item)) {
      return [`${indent}${key}: ${lines(item, "")[0]}`];
    }
    return [`${indent}${key}:`, ...lines(item, `${indent}  `)];
  });
}

export function toYamlBlock(value: JsonValue): string {
  return lines(value, "").join("\n");
}
