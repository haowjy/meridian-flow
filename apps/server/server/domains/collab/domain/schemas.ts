import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { MarkdownParser, MarkdownSerializer, type ParseSpec } from "prosemirror-markdown";
import { type Node as PMNode, Schema } from "prosemirror-model";
import type { SchemaType } from "../ports/document-sync.js";

const documentSchema = buildDocumentSchema();

const codeSchema = new Schema({
  nodes: {
    doc: { content: "code_block" },
    code_block: {
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { language: { default: null } },
    },
    text: {},
  },
  marks: {},
});

const documentMarkdownSerializer = new MarkdownSerializer(
  {
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    code_block(state, node) {
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? `${backticks.sort().at(-1) ?? "``"}\`` : "```";
      const language = node.attrs.language ? String(node.attrs.language) : "";
      state.write(`${fence}${language}\n`);
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${state.repeat("#", node.attrs.level)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    bullet_list(state, node) {
      state.renderList(node, "  ", () => "* ");
    },
    ordered_list(state, node) {
      const start = Number(node.attrs.order) || 1;
      const maxWidth = String(start + node.childCount - 1).length;
      const space = state.repeat(" ", maxWidth + 2);
      state.renderList(node, space, (index) => {
        const value = String(start + index);
        return `${state.repeat(" ", maxWidth - value.length)}${value}. `;
      });
    },
    list_item(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    hard_break(state, node, parent, index) {
      for (let i = index + 1; i < parent.childCount; i += 1) {
        if (parent.child(i).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state, node) {
      state.text(node.text ?? "");
    },
  },
  {
    em: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
    strong: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
    link: {
      open: "[",
      close(_state, mark) {
        const href = String(mark.attrs.href ?? "").replace(/[()"]/g, "\\$&");
        const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : "";
        return `](${href}${title})`;
      },
      mixable: true,
    },
    code: {
      open(_state, _mark, parent, index) {
        return backticksFor(parent.child(index), -1);
      },
      close(_state, _mark, parent, index) {
        return backticksFor(parent.child(index - 1), 1);
      },
      escape: false,
    },
  },
);

const documentMarkdownParser = new MarkdownParser(
  documentSchema,
  MarkdownIt("default", { html: false, linkify: false, typographer: false })
    .disable("html_block")
    .disable("html_inline"),
  {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "list_item" },
    bullet_list: {
      block: "bullet_list",
      getAttrs: (_token, tokens, index) => ({ tight: listIsTight(tokens, index) }),
    },
    ordered_list: {
      block: "ordered_list",
      getAttrs: (token, tokens, index) => ({
        order: Number(token.attrGet("start")) || 1,
        tight: listIsTight(tokens, index),
      }),
    },
    heading: { block: "heading", getAttrs: (token) => ({ level: Number(token.tag.slice(1)) }) },
    code_block: { block: "code_block", attrs: { language: null }, noCloseToken: true },
    fence: {
      block: "code_block",
      getAttrs: (token) => ({ language: firstWord(token.info) }),
      noCloseToken: true,
    },
    hardbreak: { node: "hard_break" },
    em: { mark: "em" },
    strong: { mark: "strong" },
    link: {
      mark: "link",
      getAttrs: (token) => ({
        href: token.attrGet("href") ?? "",
        title: token.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  } satisfies Record<string, ParseSpec>,
);

export function getSchema(type: SchemaType): Schema {
  return type === "code" ? codeSchema : documentSchema;
}

export function markdownToNode(type: SchemaType, content: string): PMNode {
  if (type === "code") {
    const block = codeSchema.node(
      "code_block",
      { language: null },
      content.length > 0 ? [codeSchema.text(content)] : [],
    );
    return codeSchema.node("doc", null, [block]);
  }
  return documentMarkdownParser.parse(content);
}

export function nodeToMarkdown(type: SchemaType, root: PMNode): string {
  if (type === "code") {
    return root.firstChild?.textContent ?? "";
  }
  return documentMarkdownSerializer.serialize(root);
}

export function blockToMarkdown(type: SchemaType, block: PMNode): string {
  if (type === "code") {
    return block.textContent;
  }
  return documentMarkdownSerializer.serialize(documentSchema.node("doc", null, [block]));
}

function firstWord(value: string): string | null {
  const word = value.trim().split(/\s+/, 1)[0];
  return word ? word : null;
}

function listIsTight(tokens: readonly Token[], index: number): boolean {
  for (let i = index + 1; i < tokens.length; i += 1) {
    if (tokens[i].type !== "list_item_open") {
      return tokens[i].hidden;
    }
  }
  return false;
}

function backticksFor(node: PMNode, side: number): string {
  const matches = node.isText ? node.text?.match(/`+/g) : null;
  const maxLength = matches?.reduce((max, value) => Math.max(max, value.length), 0) ?? 0;
  let result = maxLength > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < maxLength; i += 1) {
    result += "`";
  }
  if (maxLength > 0 && side < 0) {
    result += " ";
  }
  return result;
}
