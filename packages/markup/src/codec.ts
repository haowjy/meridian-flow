/** Builder for assembling markdown/MDX codecs from markup plugins. */

import type { Extension } from "mdast-util-from-markdown";
import type { Node as PMNode, Schema } from "prosemirror-model";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { type PluggableList, type Processor, unified } from "unified";

import type { MdastRoot } from "./ast.js";
import { CodecParseError } from "./error.js";
import { EMPTY_PARAGRAPH_SENTINEL, parseBlockAst } from "./helpers.js";
import { blockOccurrenceSpans } from "./link-occurrences.js";
import { attentionHandlers } from "./markdown/attention.js";
import { originalOffset, originalSource, type PreparedSource } from "./prepared-source.js";
import { blockSourceMap } from "./presentation-source-map.js";
import { type CodecRuntime, MARKDOWN_STRINGIFY_OPTIONS, withRuntime } from "./runtime.js";
import { createMarkdownStreamer, type SourceBlock } from "./streaming.js";
import type {
  BuildOptions,
  CodecParseErrorLocation,
  DocumentLinkScope,
  MarkupCodec,
  MarkupCodecBuilder,
  MarkupPlugin,
  OccurrenceSpan,
  ParseContext,
  PresentationSourceRun,
  SerializeContext,
} from "./types.js";

const NON_CODEC_SCHEMA_NODES = new Set(["doc", "text", "table_row", "table_header", "table_cell"]);

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
  const postSerializers = plugins
    .map((plugin) => plugin.postSerializeBlock)
    .filter((hook): hook is NonNullable<MarkupPlugin["postSerializeBlock"]> => hook !== undefined);

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

  const parseProcessor = unified().use(remarkParse).use(positionedGfm).use(remarkPlugins);
  const stringifyProcessor = unified()
    .use(remarkStringify, { ...MARKDOWN_STRINGIFY_OPTIONS, handlers: attentionHandlers })
    .use(remarkGfm)
    .use(remarkPlugins);

  const preprocess = (content: string): PreparedSource =>
    preprocessors.reduce((current, hook) => {
      const next = hook(current.value);
      if (typeof next === "string") {
        return next === current.value ? current : originalSource(next);
      }
      return {
        value: next.value,
        originalOffsets: next.originalOffsets.map(
          (offset) => current.originalOffsets[offset] ?? current.originalOffsets.at(-1) ?? 0,
        ),
      };
    }, originalSource(content));

  const parsePreparedMarkdown = (source: string): MdastRoot => {
    try {
      return postParsers.reduce(
        (current, hook) => hook(current, source),
        parseProcessor.parse(source) as MdastRoot,
      );
    } catch (error) {
      throw toCodecParseError(error);
    }
  };
  const parseMarkdown = (content: string): MdastRoot =>
    parsePreparedMarkdown(preprocess(content).value);
  const stringifyMarkdown = (root: MdastRoot): string =>
    stringifyProcessor.stringify(root as Parameters<typeof stringifyProcessor.stringify>[0]);

  const parseBlocks = (content: string, baseCtx: ParseContext): PMNode[] =>
    parseTopLevel(content, baseCtx, false).blocks;

  /** One top-level parse; spans only when asked, since every write parses. */
  const parseTopLevel = (
    content: string,
    baseCtx: ParseContext,
    withSpans: boolean,
    withSourceMap = false,
  ): {
    blocks: PMNode[];
    spans: OccurrenceSpan[];
    sourceMap: PresentationSourceRun[];
    ranges: SourceBlock[];
    tree: MdastRoot;
  } => {
    const prepared = preprocess(content);
    const source = prepared.value;
    const runtime = makeRuntime(source);
    const ctx = withRuntime<ParseContext>({ schema: baseCtx.schema }, runtime);
    if (withSourceMap) runtime.inlineOrigins = [];
    const tree = parsePreparedMarkdown(source);
    const blocks: PMNode[] = [];
    const spans: OccurrenceSpan[] = [];
    const sourceMap: PresentationSourceRun[] = [];
    const ranges: SourceBlock[] = [];
    for (const child of tree.children) {
      if (runtime.inlineOrigins) runtime.inlineOrigins.length = 0;
      const node = parseBlockAst(child, ctx);
      if (node === null) continue;
      if (withSourceMap)
        sourceMap.push(
          ...blockSourceMap(node, blocks.length, runtime.inlineOrigins ?? [], source === content),
        );
      blocks.push(node);
      const position = astOffsets(child);
      const from = originalOffset(prepared, position?.from ?? 0);
      ranges.push({
        from: physicalLineStart(content, from),
        to: originalOffset(prepared, position?.to ?? content.length),
      });
      if (withSpans)
        spans.push(
          ...blockOccurrenceSpans(node, child, source === content ? source : null, content.length),
        );
    }
    return { blocks, spans, sourceMap, ranges, tree };
  };

  const parseDocument = (content: string, withSpans: boolean, withSourceMap = false) => {
    if (content.trim().length === 0)
      return {
        blocks: [schema.node("paragraph")],
        spans: [],
        sourceMap: [],
        ranges: [{ from: 0, to: content.length }],
        tree: { type: "root", children: [] } as MdastRoot,
      };
    const parsed = parseTopLevel(content, { schema }, withSpans, withSourceMap);
    return parsed.blocks.length > 0
      ? parsed
      : {
          ...parsed,
          blocks: [schema.node("paragraph")],
          ranges: [{ from: 0, to: content.length }],
        };
  };

  const makeRuntime = (source: string): CodecRuntime => ({
    source,
    schema,
    blocks,
    blockMap,
    markMap,
    parseMarkdown,
    parseBlocks,
    stringifyMarkdown,
    serializeBlock: serializeWithHooks,
  });

  const serializeWithHooks = (block: PMNode, ctx: SerializeContext): string => {
    const codec = blockMap.get(block.type.name);
    if (!codec) throw new Error(`pm->mdast: unsupported block node "${block.type.name}"`);
    return postSerializers.reduce(
      (current, hook) => hook(block, current, ctx),
      codec.serialize(block, ctx),
    );
  };

  const serializeOne = (block: PMNode, ctx: SerializeContext): string =>
    ensureTrailingNewline(serializeWithHooks(block, ctx));

  const serializeBody = (block: PMNode, ctx: SerializeContext): string => {
    const body = trimOneTrailingNewline(serializeOne(block, ctx));
    return body === EMPTY_PARAGRAPH_SENTINEL ? "" : body;
  };

  const serializeBlocks = (blockList: readonly PMNode[], links: DocumentLinkScope): string[] => {
    const runtime = makeRuntime("");
    const ctx = withRuntime<SerializeContext>({ schema, links }, runtime);
    return blockList.map((block) => serializeBody(block, ctx));
  };

  const stream = createMarkdownStreamer((content) => parseDocument(content, false));

  return {
    serialize(blockList: PMNode[], links: DocumentLinkScope): string {
      const runtime = makeRuntime("");
      const ctx = withRuntime<SerializeContext>({ schema, links }, runtime);
      const result = blockList.map((block) => serializeOne(block, ctx)).join("\n");
      if (result.replace(/\s/g, "").replace(/ /g, "").length === 0) return "";
      return result;
    },

    parse(content: string) {
      return { blocks: parseDocument(content, false).blocks };
    },

    parseWithSpans(content: string) {
      const { blocks, spans } = parseDocument(content, true);
      return { blocks, spans };
    },

    parseWithSourceMap(content: string) {
      const { blocks, sourceMap } = parseDocument(content, false, true);
      return { blocks, sourceMap };
    },

    serializeBlock(block: PMNode, links: DocumentLinkScope): string {
      return serializeBlocks([block], links)[0] ?? "";
    },

    serializeBlocks,
    stream,
  };
}

function astOffsets(node: unknown): SourceBlock | null {
  if (!node || typeof node !== "object") return null;
  const position = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } }
  ).position;
  const from = position?.start?.offset;
  const to = position?.end?.offset;
  return typeof from === "number" && typeof to === "number" ? { from, to } : null;
}

function physicalLineStart(source: string, offset: number): number {
  const newline = source.lastIndexOf("\n", Math.max(0, offset - 1));
  return newline === -1 ? 0 : newline + 1;
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

/** Keep GFM token positions; its legacy text transform invents positionless links even from escaped URLs. */
function positionedGfm(this: Processor): void {
  remarkGfm.call(this);
  // Depends on remark-gfm's extension shape; the bare-prose round-trip row guards upgrades.
  const extensions = this.data().fromMarkdownExtensions ?? [];
  const removeLegacyAutolinks = (extension: Extension | Extension[]): void => {
    if (Array.isArray(extension)) {
      extension.forEach(removeLegacyAutolinks);
    } else if (extension.enter?.literalAutolink) {
      extension.transforms = [];
    }
  };
  extensions.forEach(removeLegacyAutolinks);
}
