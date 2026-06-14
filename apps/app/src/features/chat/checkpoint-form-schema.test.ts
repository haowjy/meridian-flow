import { describe, expect, it } from "vitest";

import {
  checkpointFieldsFromSchema,
  initialFormValues,
  validateFormValues,
} from "./checkpoint-form-schema";

describe("checkpointFieldsFromSchema", () => {
  it("derives fields with required, kind, description, and defaults", () => {
    const fields = checkpointFieldsFromSchema({
      type: "object",
      properties: {
        bucket: {
          type: "string",
          enum: ["a", "b", "c"],
          description: "Pick a bucket",
          default: "b",
        },
        notes: { type: "string", description: "Optional notes" },
        count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
        weight: { type: "number", minimum: 0 },
        enabled: { type: "boolean", default: true },
      },
      required: ["bucket", "count"],
    });

    expect(fields).toHaveLength(5);
    const bucket = fields.find((field) => field.name === "bucket");
    expect(bucket?.kind).toBe("enum");
    expect(bucket?.required).toBe(true);
    expect(bucket?.options?.map((option) => option.value)).toEqual(["a", "b", "c"]);
    expect(bucket?.defaultValue).toBe("b");

    const notes = fields.find((field) => field.name === "notes");
    expect(notes?.kind).toBe("string");
    expect(notes?.required).toBe(false);

    const count = fields.find((field) => field.name === "count");
    expect(count?.kind).toBe("integer");
    expect(count?.minimum).toBe(1);
    expect(count?.maximum).toBe(5);
    expect(count?.defaultValue).toBe(2);

    const enabled = fields.find((field) => field.name === "enabled");
    expect(enabled?.kind).toBe("boolean");
    expect(enabled?.defaultValue).toBe(true);
  });

  it("ignores unsupported field shapes (nested objects, anyOf) instead of crashing", () => {
    const fields = checkpointFieldsFromSchema({
      type: "object",
      properties: {
        nested: { type: "object" },
        oneOf: { oneOf: [{ type: "string" }, { type: "number" }] },
        plain: { type: "string" },
      },
      required: ["plain"],
    });

    expect(fields.map((field) => field.name)).toEqual(["plain"]);
  });

  it("returns no fields for non-object root schemas", () => {
    expect(checkpointFieldsFromSchema({ type: "string" })).toEqual([]);
  });
});

describe("initialFormValues", () => {
  it("prefers `recommended` over schema default, falls back to empty sentinels", () => {
    const fields = checkpointFieldsFromSchema({
      type: "object",
      properties: {
        bucket: { type: "string", enum: ["a", "b"], default: "a" },
        notes: { type: "string" },
        count: { type: "integer", default: 7 },
      },
      required: ["bucket"],
    });

    const values = initialFormValues(fields, { bucket: "b", count: 3 });
    expect(values).toEqual({ bucket: "b", notes: "", count: 3 });

    const fallback = initialFormValues(fields, null);
    expect(fallback).toEqual({ bucket: "a", notes: "", count: 7 });
  });
});

describe("validateFormValues", () => {
  const fields = checkpointFieldsFromSchema({
    type: "object",
    properties: {
      bucket: { type: "string", enum: ["a", "b"] },
      notes: { type: "string" },
      count: { type: "integer", minimum: 1, maximum: 10 },
      weight: { type: "number" },
      enabled: { type: "boolean" },
    },
    required: ["bucket", "count"],
  });

  it("blocks empty required fields", () => {
    const { errors, answer } = validateFormValues(fields, {
      bucket: "",
      notes: "",
      count: "",
      weight: "",
      enabled: false,
    });
    expect(errors.bucket).toBe("Required");
    expect(errors.count).toBe("Required");
    expect(answer.bucket).toBeUndefined();
    expect(answer.enabled).toBe(false);
  });

  it("rejects enum values outside the allowed set", () => {
    const { errors } = validateFormValues(fields, {
      bucket: "z",
      notes: "",
      count: 3,
      weight: "",
      enabled: false,
    });
    expect(errors.bucket).toBe("Choose a listed option");
  });

  it("enforces numeric bounds and integer-only", () => {
    const { errors } = validateFormValues(fields, {
      bucket: "a",
      notes: "",
      count: 0,
      weight: "",
      enabled: false,
    });
    expect(errors.count).toContain("at least 1");

    const tooHigh = validateFormValues(fields, {
      bucket: "a",
      notes: "",
      count: 99,
      weight: "",
      enabled: false,
    });
    expect(tooHigh.errors.count).toContain("at most 10");

    const fractional = validateFormValues(fields, {
      bucket: "a",
      notes: "",
      count: 1.5,
      weight: "",
      enabled: false,
    });
    expect(fractional.errors.count).toContain("whole number");
  });

  it("builds an answer object keyed by property name when valid", () => {
    const { errors, answer } = validateFormValues(fields, {
      bucket: "b",
      notes: "hello",
      count: 4,
      weight: 1.5,
      enabled: true,
    });
    expect(errors).toEqual({});
    expect(answer).toEqual({
      bucket: "b",
      notes: "hello",
      count: 4,
      weight: 1.5,
      enabled: true,
    });
  });
});
