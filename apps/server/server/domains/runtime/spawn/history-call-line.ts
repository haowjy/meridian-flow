import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

const KEEP_STEPS = [40, 16, 0] as const;
const SLACK = 20;
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

export function shortenCallArgs(tool: string, args: JsonObject): JsonObject {
  let shortened = args;
  for (const keep of KEEP_STEPS) {
    shortened = shorten(args, keep) as JsonObject;
    if (callText(tool, shortened).length <= CALL_LINE_CAP) break;
  }
  return shortened;
}

interface CallLineInput {
  tool: string;
  args: JsonObject | null;
  state: "done" | "error" | "cancelled" | "running";
  summary?: string;
}

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
