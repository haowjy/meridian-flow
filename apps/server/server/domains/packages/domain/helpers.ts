// @ts-nocheck
/**
 * Shared coercion/hashing utilities for the package domain: safe JSON-shape
 * accessors (objectAt, stringsAt, ...), sha256, and Node-error guards. Owns the
 * defensive parsing primitives used by mars-source/sync/resolution; depends only
 * on the domain types.
 */
import { createHash } from "node:crypto";

import type { JsonObject } from "./types.js";

export function objectAt(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

export function stringsAt(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function stringAt(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function booleanAt(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function sortedEntries(files: Record<string, string>): [string, string][] {
  return Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
