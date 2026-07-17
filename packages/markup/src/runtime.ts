/** Hidden runtime threaded through codec contexts for helper dispatch. */

import type { Node as PMNode, Schema } from "prosemirror-model";

import type { MdastRoot } from "./ast.js";
import type { BlockCodec, MarkCodec, ParseContext, SerializeContext } from "./types.js";

/** Frozen remark-stringify options — the codec-wide determinism contract. */
export const MARKDOWN_STRINGIFY_OPTIONS = {
  bullet: "-",
  bulletOther: "*",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  incrementListMarker: true,
  resourceLink: false,
  setext: false,
  tightDefinitions: true,
} as const;

export interface CodecRuntime {
  source: string;
  schema: Schema;
  blocks: readonly BlockCodec[];
  blockMap: ReadonlyMap<string, BlockCodec>;
  markMap: ReadonlyMap<string, MarkCodec>;
  parseMarkdown(content: string): MdastRoot;
  stringifyMarkdown(root: MdastRoot): string;
  serializeBlock(node: PMNode, ctx: SerializeContext): string;
}

const runtimeKey: unique symbol = Symbol("markup-codec-runtime");

type RuntimeContext = (SerializeContext | ParseContext) & { [runtimeKey]?: CodecRuntime };

export function withRuntime<T extends SerializeContext | ParseContext>(
  ctx: T,
  runtime: CodecRuntime,
): T {
  (ctx as RuntimeContext)[runtimeKey] = runtime;
  return ctx;
}

export function getRuntime(ctx: SerializeContext | ParseContext): CodecRuntime {
  const runtime = (ctx as RuntimeContext)[runtimeKey];
  if (!runtime) throw new Error("codec runtime missing from context");
  return runtime;
}
