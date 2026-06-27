/** Builder for assembling markdown/MDX codecs from markup plugins. */

import type { Node as PMNode, Schema } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { type PluggableList, unified } from "unified";

import type { MdastRoot } from "./ast.js";
import { CodecParseError } from "./error.js";
import { EMPTY_PARAGRAPH_SENTINEL, parseBlockAst } from "./helpers.js";
import { type CodecRuntime, MARKDOWN_STRINGIFY_OPTIONS, withRuntime } from "./runtime.js";
import type {
  BuildOptions,
  CodecParseErrorLocation,
  MarkupCodec,
  MarkupCodecBuilder,
  MarkupPlugin,
  ParseContext,
  SerializeContext,
} from "./types.js";

const NON_CODEC_SCHEMA_NODES = new Set([
  "doc",
  "text",
  "hard_break",
  "table_row",
  "table_header",
  "table_cell",
]);

export function requiredBlockNamesForSchema(schema: Schema): string[] {
  return Object.keys(schema.nodes).filter((name) => !NON_CODEC_SCHEMA_NODES.has(name));
}

export function createMarkupCodec(options: { schema: Schema }): MarkupCodecBuilder {
  const plugins: MarkupPlugin[] = [];
  return {
    use(plugin: MarkupPlugin) {
      plugins.push(plugin);
      return this;
    },
    build(buildOptions?: BuildOptions) {
      return buildMarkupCodec(options.schema, plugins, buildOptions ?? {});
    },
  };
}

function buildMarkupCodec(
  schema: Schema,
  plugins: readonly MarkupPlugin[],
  options: BuildOptions,
): MarkupCodec {
  const blocks = [...plugins].reverse().flatMap((plugin) => [...(plugin.blocks ?? [])]);
  const marks = plugins.flatMap((plugin) => [...(plugin.marks ?? [])]);
  const remarkPlugins = plugins.flatMap((plugin) => plugin.remarkPlugins ?? []) as PluggableList;
  const preprocessors = plugins
    .map((plugin) => plugin.preprocess)
    .filter((hook): hook is NonNullable<MarkupPlugin["preprocess"]> => hook !== undefined)
    .reverse();
  const postParsers = plugins
    .map((plugin) => plugin.postParse)
    .filter((hook): hook is NonNullable<MarkupPlugin["postParse"]> => hook !== undefined);

  const blockMap = uniqueCodecMap(blocks, "block");
  const markMap = uniqueCodecMap(marks, "mark");

  for (const markName of Object.keys(schema.marks)) {
    if (!markMap.has(markName))
      throw new Error(`codec missing MarkCodec for schema mark "${markName}"`);
  }
  const requiredBlockNames = new Set([
    ...(options.requiredBlockNames ?? []),
    ...(options.requireSchemaBlockCoverage ? requiredBlockNamesForSchema(schema) : []),
  ]);
  for (const blockName of requiredBlockNames) {
    if (!blockMap.has(blockName))
      throw new Error(`codec missing BlockCodec for schema node "${blockName}"`);
  }

  const parseProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkPlugins);
  const stringifyProcessor = unified()
    .use(remarkStringify, MARKDOWN_STRINGIFY_OPTIONS)
    .use(remarkGfm)
    .use(remarkPlugins);

  const preprocess = (content: string): string =>
    preprocessors.reduce((current, hook) => hook(current), content);

  const parsePreparedMarkdown = (source: string): MdastRoot => {
    try {
      return parseProcessor.parse(source) as MdastRoot;
    } catch (error) {
      throw toCodecParseError(error);
    }
  };
  const parseMarkdown = (content: string): MdastRoot => parsePreparedMarkdown(preprocess(content));
  const stringifyMarkdown = (root: MdastRoot): string =>
    stringifyProcessor.stringify(root as Parameters<typeof stringifyProcessor.stringify>[0]);

  const makeRuntime = (source: string): CodecRuntime => ({
    source,
    schema,
    blocks,
    blockMap,
    markMap,
    parseMarkdown,
    stringifyMarkdown,
  });

  const serializeOne = (block: PMNode, ctx: SerializeContext): string => {
    const codec = blockMap.get(block.type.name);
    if (!codec) throw new Error(`pm->mdast: unsupported block node "${block.type.name}"`);
    return ensureTrailingNewline(codec.serialize(block, ctx));
  };

  const serializeBody = (block: PMNode, ctx: SerializeContext): string => {
    const body = trimOneTrailingNewline(serializeOne(block, ctx));
    return body === EMPTY_PARAGRAPH_SENTINEL ? "" : body;
  };

  const serializeBlocks = (blockList: readonly PMNode[]): string[] => {
    const runtime = makeRuntime("");
    const ctx = withRuntime<SerializeContext>({ schema }, runtime);
    return blockList.map((block) => serializeBody(block, ctx));
  };

  return {
    serialize(blockList: PMNode[]): string {
      const runtime = makeRuntime("");
      const ctx = withRuntime<SerializeContext>({ schema }, runtime);
      return blockList.map((block) => serializeOne(block, ctx)).join("\n");
    },

    parse(content: string) {
      if (content.trim().length === 0) {
        return { blocks: [schema.node("paragraph")] };
      }
      const source = preprocess(content);
      const runtime = makeRuntime(source);
      const ctx = withRuntime<ParseContext>({ schema }, runtime);
      const tree = postParsers.reduce(
        (current, hook) => hook(current),
        parsePreparedMarkdown(source),
      );
      const parsed = tree.children
        .map((child) => parseBlockAst(child, ctx))
        .filter((node): node is PMNode => node !== null);
      return { blocks: parsed.length > 0 ? parsed : [schema.node("paragraph")] };
    },

    serializeBlock(block: PMNode): string {
      return serializeBlocks([block])[0] ?? "";
    },

    serializeBlocks,
  };
}

function toCodecParseError(error: unknown): CodecParseError {
  if (error instanceof CodecParseError) return error;
  const location = parseErrorLocation(error);
  const reason = parseErrorReason(error);
  const where = location.line === undefined ? "" : ` at ${location.line}:${location.column ?? 1}`;
  return new CodecParseError(`Could not parse markdown/MDX${where}: ${reason}`, location, error);
}

function parseErrorLocation(error: unknown): CodecParseErrorLocation {
  const record = asRecord(error);
  const place = asRecord(record?.place);
  const start = asRecord(place?.start);
  const line = numberValue(record?.line) ?? numberValue(start?.line);
  const column = numberValue(record?.column) ?? numberValue(start?.column);
  return { line, column };
}

function parseErrorReason(error: unknown): string {
  const record = asRecord(error);
  const reason = record?.reason;
  if (typeof reason === "string" && reason.length > 0) return reason;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "invalid syntax";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function uniqueCodecMap<T extends { name: string }>(
  codecs: readonly T[],
  kind: "block" | "mark",
): Map<string, T> {
  const map = new Map<string, T>();
  for (const codec of codecs) {
    if (map.has(codec.name))
      throw new Error(`duplicate ${kind} codec registration "${codec.name}"`);
    map.set(codec.name, codec);
  }
  return map;
}

function ensureTrailingNewline(value: string): string {
  return `${value.replace(/\n*$/, "")}\n`;
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}
