/**
 * Serialization helpers shared by provider request mappers.
 *
 * Currently provides safeToolOutput: normalizes tool execution results into
 * a JSON string that provider APIs accept. Tool output in Meridian is structured
 * (JsonValue), but providers expect stringified tool results in their API.
 */

/**
 * Normalize a tool output value into a non-empty string suitable for
 * provider API consumption.
 *
 * Rules:
 * - Strings pass through unless empty (then stringify as "").
 * - null/undefined → "null" (both providers accept this).
 * - Objects/arrays/numbers/booleans → JSON.stringify().
 * - If JSON.stringify fails (cyclic objects, BigInts, etc.), fall back to
 *   String(output) and, if that's empty, "null".
 *
 * The guaranteed non-empty return means provider APIs never receive an empty
 * tool result body, which some reject.
 */
export function safeToolOutput(output: unknown): string {
  if (typeof output === "string") return output.length > 0 ? output : JSON.stringify("");
  if (output === null || output === undefined) return "null";

  try {
    const serialized = JSON.stringify(output);
    if (serialized !== undefined && serialized.length > 0) return serialized;
  } catch {
    // Fall through to String(output) for cyclic/non-JSON values.
  }

  const fallback = String(output);
  return fallback.length > 0 ? fallback : "null";
}
