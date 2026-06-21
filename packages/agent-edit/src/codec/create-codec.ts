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
import type {
  Block,
  BlockCodec,
  Codec,
  MarkCodec,
  ParseContext,
  SerializeContext,
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
  for (const blockName of options.requiredBlockNames ?? []) {
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

  const parseMarkdown = (content: string): MdastRoot =>
    parseProcessor.parse(preprocess(content)) as MdastRoot;
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
      const tree = demoteAutolinks(parseProcessor.parse(source) as MdastRoot);
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
