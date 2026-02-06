/**
 * safeJsonForDisplay
 *
 * Tool inputs/results can be extremely large (e.g. doc_create.content).
 * `JSON.stringify` on the raw value can freeze the UI.
 *
 * This utility truncates large strings/collections before stringifying so rendering
 * stays responsive. It is intended for UI display only.
 */

export interface SafeJsonForDisplayOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxArrayLength?: number;
  maxStringHead?: number;
  maxStringTail?: number;
  maxStringTotal?: number;
}

const DEFAULTS: Required<SafeJsonForDisplayOptions> = {
  maxDepth: 5,
  maxKeys: 200,
  maxArrayLength: 200,
  maxStringHead: 240,
  maxStringTail: 120,
  maxStringTotal: 1200,
};

function truncateString(
  value: string,
  opts: Required<SafeJsonForDisplayOptions>,
): string {
  if (value.length <= opts.maxStringTotal) return value;
  const head = value.slice(0, opts.maxStringHead);
  const tail = value.slice(-opts.maxStringTail);
  return `${head}…(${value.length} chars)…${tail}`;
}

function truncateValue(
  value: unknown,
  opts: Required<SafeJsonForDisplayOptions>,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === "string") return truncateString(value as string, opts);
  if (valueType === "number" || valueType === "boolean") return value;

  if (depth >= opts.maxDepth) return "…";

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    const limit = Math.min(arr.length, opts.maxArrayLength);
    const out = new Array(limit);
    for (let i = 0; i < limit; i++) {
      out[i] = truncateValue(arr[i], opts, depth + 1, seen);
    }
    if (arr.length > limit) {
      out.push(`…(${arr.length - limit} more items)`);
    }
    return out;
  }

  if (valueType === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);

    const entries = Object.entries(obj);
    const limit = Math.min(entries.length, opts.maxKeys);
    const out: Record<string, unknown> = {};
    for (let i = 0; i < limit; i++) {
      const [k, v] = entries[i]!;
      out[k] = truncateValue(v, opts, depth + 1, seen);
    }
    if (entries.length > limit) {
      out.__truncated__ = `…(${entries.length - limit} more keys)`;
    }
    return out;
  }

  return String(value);
}

export function safeJsonStringify(
  value: unknown,
  opts?: SafeJsonForDisplayOptions,
): string {
  const options = { ...DEFAULTS, ...(opts ?? {}) };
  const truncated = truncateValue(value, options, 0, new WeakSet<object>());

  try {
    return JSON.stringify(truncated, null, 2);
  } catch {
    // BigInt, Symbol, or other non-serializable values that escaped truncation
    try {
      // Fallback: try without pretty printing
      return JSON.stringify(truncated);
    } catch {
      // Final fallback: return placeholder
      return '"[Unable to serialize]"';
    }
  }
}
