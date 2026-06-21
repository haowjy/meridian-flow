import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode, Schema } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { type PluggableList, unified } from "unified";

import type { ComponentRegistry } from "../registry/component-registry.js";
import {
  type CodecRuntime,
  demoteAutolinks,
  EMPTY_PARAGRAPH_SENTINEL,
  escapeProseForMdxIngress,
  MARKDOWN_STRINGIFY_OPTIONS,
  type MdastRoot,
  parseBlockAst,
  withRuntime,
} from "./internal.js";
import type { Block, BlockCodec, Codec, CodecParseErrorLocation } from "./types.js";
import {
  CodecParseError,
  type MarkCodec,
  type ParseContext,
  type SerializeContext,
} from "./types.js";

export interface CreateCodecOptions {
  blocks: readonly BlockCodec[];
  marks: readonly MarkCodec[];
  schema?: Schema;
  components?: ComponentRegistry;
  remarkPlugins?: PluggableList;
  mdx?: boolean;
  /** Node names that must have BlockCodec registrations for this preset. */
  requiredBlockNames?: readonly string[];
  /** Require one BlockCodec for every schema node that serializes as document content. */
  requireSchemaBlockCoverage?: boolean;
}

const NON_CODEC_SCHEMA_NODES = new Set(["doc", "text", "hard_break"]);

export function requiredBlockNamesForSchema(schema: Schema): string[] {
  return Object.keys(schema.nodes).filter((name) => !NON_CODEC_SCHEMA_NODES.has(name));
}

export function createCodec(options: CreateCodecOptions): Codec {
  const schema = options.schema ?? buildDocumentSchema();
  const components = options.components;
  const blocks = [...options.blocks];
  const marks = [...options.marks];
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

  const parseProcessor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(options.remarkPlugins ?? []);
  const stringifyProcessor = unified()
    .use(remarkStringify, MARKDOWN_STRINGIFY_OPTIONS)
    .use(remarkGfm)
    .use(options.remarkPlugins ?? []);

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
    components,
    blocks,
    blockMap,
    markMap,
    parseMarkdown,
    stringifyMarkdown,
    mdx: options.mdx === true,
  });

  const preprocess = (content: string): string =>
    options.mdx === true ? escapeProseForMdxIngress(content) : content;

  const serializeOne = (block: PMNode, ctx: SerializeContext): string => {
    const codec = blockMap.get(block.type.name);
    if (!codec) throw new Error(`pm->mdast: unsupported block node "${block.type.name}"`);
    return ensureTrailingNewline(codec.serialize(block, ctx));
  };

  return {
    blocks,
    marks,

    serialize(blockList: Block[], opts?: { hashes: boolean }): string {
      if (opts?.hashes) {
        throw new Error("serialize({ hashes: true }) requires serializeBlock(block, hash)");
      }
      const runtime = makeRuntime("");
      const ctx = withRuntime<SerializeContext>({ schema, components }, runtime);
      return blockList.map((block) => serializeOne(block, ctx)).join("\n");
    },

    parse(content: string) {
      if (content.trim().length === 0) {
        return { blocks: [schema.node("paragraph")] };
      }
      const source = preprocess(content);
      const runtime = makeRuntime(source);
      const ctx = withRuntime<ParseContext>({ schema, components }, runtime);
      const tree = demoteAutolinks(parsePreparedMarkdown(source));
      const parsed = tree.children
        .map((child) => parseBlockAst(child, ctx))
        .filter((node): node is PMNode => node !== null);
      return { blocks: parsed.length > 0 ? parsed : [schema.node("paragraph")] };
    },

    serializeBlock(block: Block, hash: string): string {
      const body = trimOneTrailingNewline(this.serialize([block]));
      const displayBody = body === EMPTY_PARAGRAPH_SENTINEL ? "" : body;
      if (displayBody.includes("\n")) return `${hash}|\n${displayBody}`;
      return `${hash}|${displayBody}`;
    },
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
