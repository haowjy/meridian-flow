/**
 * interrupt-form-schema — small JSON-Schema-ish parser for the generic
 * interrupt card's form generator.
 *
 * Purpose: read the `answerSchema` on a `AskRequest`, derive a flat list
 * of form fields the renderer can lay out, and validate user input before
 * submit. The runtime card is domain-agnostic — schema shape supplies all
 * semantics — so this module owns the only place where JSON Schema vocabulary
 * leaks into the frontend.
 *
 * Supported subset (deliberate — comment any new vocabulary you add):
 *   - Root must be `{ type: "object", properties: {...}, required?: string[] }`.
 *   - Each property is either:
 *       * `{ type: "string", enum?: string[], description?, default? }`
 *       * `{ type: "number" | "integer", description?, default?, minimum?, maximum? }`
 *       * `{ type: "boolean", description?, default? }`
 *   - `required` lists property keys that must be present and non-empty.
 *
 * Not supported (and intentionally ignored): nested objects, `oneOf`/`anyOf`,
 * `pattern`, format hints, conditional schemas. The package can extend the
 * subset by raising it back to the contract — comment the addition here.
 */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

export type InterruptFieldKind = "string" | "enum" | "number" | "integer" | "boolean";

export type InterruptEnumOption = {
  value: string;
  label: string;
};

export type InterruptField = {
  /** Property name in the answer object — also the form input id. */
  name: string;
  kind: InterruptFieldKind;
  required: boolean;
  description?: string;
  /** Schema-supplied default; also the suggested-default hint in the UI. */
  defaultValue?: string | number | boolean;
  /** Populated only for `kind === "enum"`. */
  options?: InterruptEnumOption[];
  /** Numeric bounds (number/integer). */
  minimum?: number;
  maximum?: number;
};

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonObject;
}

function stringList(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

function parseField(name: string, raw: JsonValue, required: boolean): InterruptField | null {
  const obj = asObject(raw);
  if (!obj) return null;

  const description = typeof obj.description === "string" ? obj.description : undefined;
  const rawDefault = obj.default;

  const enumValues = stringList(obj.enum);
  if (enumValues && enumValues.length > 0) {
    return {
      name,
      kind: "enum",
      required,
      description,
      defaultValue: typeof rawDefault === "string" ? rawDefault : undefined,
      options: enumValues.map((value) => ({ value, label: value })),
    };
  }

  const type = obj.type;
  if (type === "string") {
    return {
      name,
      kind: "string",
      required,
      description,
      defaultValue: typeof rawDefault === "string" ? rawDefault : undefined,
    };
  }
  if (type === "number" || type === "integer") {
    const field: InterruptField = {
      name,
      kind: type,
      required,
      description,
      defaultValue: typeof rawDefault === "number" ? rawDefault : undefined,
    };
    if (typeof obj.minimum === "number") field.minimum = obj.minimum;
    if (typeof obj.maximum === "number") field.maximum = obj.maximum;
    return field;
  }
  if (type === "boolean") {
    return {
      name,
      kind: "boolean",
      required,
      description,
      defaultValue: typeof rawDefault === "boolean" ? rawDefault : undefined,
    };
  }

  return null;
}

export function interruptFieldsFromSchema(schema: JsonObject): InterruptField[] {
  if (schema.type !== "object") return [];
  const properties = asObject(schema.properties);
  if (!properties) return [];
  const required = new Set(stringList(schema.required) ?? []);

  const fields: InterruptField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const field = parseField(name, raw as JsonValue, required.has(name));
    if (field) fields.push(field);
  }
  return fields;
}

export type InterruptFormValues = Record<string, string | number | boolean>;

export function initialFormValues(
  fields: InterruptField[],
  recommended: JsonValue | null,
): InterruptFormValues {
  const values: InterruptFormValues = {};
  const recommendedObj = asObject(recommended ?? undefined);

  for (const field of fields) {
    const recommendedRaw = recommendedObj?.[field.name];
    const recommendedValue = coerceToFieldValue(field, recommendedRaw);
    if (recommendedValue !== undefined) {
      values[field.name] = recommendedValue;
      continue;
    }
    if (field.defaultValue !== undefined) {
      values[field.name] = field.defaultValue;
      continue;
    }
    // Sentinel empty values so controlled inputs stay controlled. The
    // submit-time validator differentiates "empty" from "unset" via the
    // required check.
    values[field.name] =
      field.kind === "boolean"
        ? false
        : field.kind === "number" || field.kind === "integer"
          ? ""
          : "";
  }

  return values;
}

function coerceToFieldValue(
  field: InterruptField,
  raw: JsonValue | undefined,
): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (field.kind) {
    case "string":
    case "enum":
      return typeof raw === "string" ? raw : undefined;
    case "number":
    case "integer":
      return typeof raw === "number" ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
  }
}

export type InterruptFormErrors = Record<string, string>;

/**
 * Validate the form against the field list. Returns the errors map and the
 * answer object the renderer will send when there are no errors. Numeric
 * fields stored as the empty string are treated as "unset" — they fail the
 * required check, but pass when optional.
 */
export function validateFormValues(
  fields: InterruptField[],
  values: InterruptFormValues,
): { errors: InterruptFormErrors; answer: JsonObject } {
  const errors: InterruptFormErrors = {};
  const answer: JsonObject = {};

  for (const field of fields) {
    const raw = values[field.name];

    if (field.kind === "boolean") {
      const bool = raw === true;
      answer[field.name] = bool;
      continue;
    }

    if (field.kind === "number" || field.kind === "integer") {
      if (raw === "" || raw === undefined || raw === null) {
        if (field.required) errors[field.name] = "Required";
        continue;
      }
      const num = typeof raw === "number" ? raw : Number(raw);
      if (Number.isNaN(num)) {
        errors[field.name] = "Must be a number";
        continue;
      }
      if (field.kind === "integer" && !Number.isInteger(num)) {
        errors[field.name] = "Must be a whole number";
        continue;
      }
      if (field.minimum !== undefined && num < field.minimum) {
        errors[field.name] = `Must be at least ${field.minimum}`;
        continue;
      }
      if (field.maximum !== undefined && num > field.maximum) {
        errors[field.name] = `Must be at most ${field.maximum}`;
        continue;
      }
      answer[field.name] = num;
      continue;
    }

    // string / enum
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text.length === 0) {
      if (field.required) errors[field.name] = "Required";
      continue;
    }
    if (field.kind === "enum") {
      const allowed = field.options?.some((option) => option.value === text);
      if (!allowed) {
        errors[field.name] = "Choose a listed option";
        continue;
      }
    }
    answer[field.name] = text;
  }

  return { errors, answer };
}
