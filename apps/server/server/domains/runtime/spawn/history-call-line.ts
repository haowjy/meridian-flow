/**
 * One tool call as `thread_history` writes it (D48):
 * `name({json args}) → summary`.
 *
 * The arguments are the model's own, as compact JSON in the key order it sent.
 * Long strings are cut inside the JSON, at any depth: a string over
 * keep + 20 characters becomes its first `keep` characters (backed off to a
 * word break) then `…(N words)`, or `…(N chars)` for a single word. `keep`
 * starts at 40, so a cut value is about 55 characters. When the call is still
 * over 300 characters, `keep` drops to 16, then 0; keys are never dropped.
 *
 * Postgres `jsonb` doesn't keep the key order the model sent, so the keys are
 * put back in the tool's input-schema order (the matching `oneOf` variant's),
 * which is the order models emit; keys the schema doesn't name come last.
 */
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

/** Prefix lengths tried in turn until the call fits `CALL_LINE_CAP`. */
const KEEP_STEPS = [40, 16, 0] as const;
/** A string is cut only when cutting saves more than this. */
const SLACK = 20;
/** Characters in `name({...})`, before the result summary. */
export const CALL_LINE_CAP = 300;

const count = (value: number) => value.toLocaleString("en-US");

function sizeNote(text: string) {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  return words > 1 ? `${count(words)} words` : `${count(Array.from(text).length)} chars`;
}

function cut(text: string, keep: number) {
  const chars = Array.from(text);
  if (chars.length <= keep + SLACK) return text;
  let prefix = chars.slice(0, keep).join("");
  const space = prefix.search(/\s\S*$/u);
  if (space > keep / 2) prefix = prefix.slice(0, space);
  return `${prefix.trimEnd()}…(${sizeNote(text)})`;
}

function shorten(value: JsonValue, keep: number): JsonValue {
  if (typeof value === "string") return cut(value, keep);
  if (Array.isArray(value)) return value.map((item) => shorten(item, keep));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shorten(item as JsonValue, keep)]),
    );
  return value;
}

interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  const?: unknown;
  enum?: unknown[];
}

const accepts = (schema: JsonSchemaNode | undefined, value: JsonValue | undefined) =>
  schema?.const !== undefined
    ? schema.const === value
    : schema?.enum
      ? schema.enum.includes(value)
      : true;

/**
 * The object schema that describes `value`: of a union's variants whose
 * discriminators accept it, the one naming most of its keys (the first on a tie).
 */
function objectSchema(schema: JsonSchemaNode, value: JsonObject): JsonSchemaNode | undefined {
  const options = schema.oneOf ?? schema.anyOf;
  if (!options) return schema.properties ? schema : undefined;
  let best: { option: JsonSchemaNode; named: number } | undefined;
  for (const option of options) {
    const properties = option.properties;
    if (!properties) continue;
    const keys = Object.keys(value).filter((key) => key in properties);
    if (!keys.every((key) => accepts(properties[key], value[key]))) continue;
    if (!best || keys.length > best.named) best = { option, named: keys.length };
  }
  return best?.option;
}

/** `value` with its object keys in the order `schema` declares them, at any depth. */
export function orderLikeSchema(value: JsonValue, schema: unknown): JsonValue {
  const node = (schema ?? {}) as JsonSchemaNode;
  if (Array.isArray(value)) {
    const items = node.items ?? (node.oneOf ?? node.anyOf)?.find((option) => option.items)?.items;
    return value.map((item) => orderLikeSchema(item, items));
  }
  if (value === null || typeof value !== "object") return value;
  const properties = objectSchema(node, value)?.properties ?? {};
  const keys = [
    ...Object.keys(properties).filter((key) => key in value),
    ...Object.keys(value).filter((key) => !(key in properties)),
  ];
  return Object.fromEntries(
    keys.map((key) => [key, orderLikeSchema(value[key] as JsonValue, properties[key])]),
  );
}

const callText = (tool: string, args: JsonObject | null) =>
  `${tool}(${args === null ? "…" : JSON.stringify(args)})`;

/** The call's arguments as a history line quotes them. */
export function shortenCallArgs(tool: string, args: JsonObject): JsonObject {
  let shortened = args;
  for (const keep of KEEP_STEPS) {
    shortened = shorten(args, keep) as JsonObject;
    if (callText(tool, shortened).length <= CALL_LINE_CAP) break;
  }
  return shortened;
}

export interface CallLineInput {
  tool: string;
  /** Already shortened; null when history withholds them. */
  args: JsonObject | null;
  state: "done" | "error" | "cancelled" | "running";
  /** A finished call's result in brief, or a failed call's status or code. */
  summary?: string;
}

/** `name({...})`, then ` → ` and what came of it when there is anything to say. */
export function callLine(item: CallLineInput): string {
  const outcome =
    item.state === "error"
      ? `failed${item.summary ? `: ${item.summary}` : ""}`
      : item.state === "done"
        ? item.summary
        : item.state;
  const call = callText(item.tool, item.args);
  return outcome ? `${call} → ${outcome}` : call;
}
