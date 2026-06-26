/** Markdown and MDX AST shapes used by markup codecs. */

export type MdastRoot = { type: "root"; children: MdastBlock[] };
export type MdastBlock =
  | MdastParagraph
  | MdastHeading
  | MdastBlockquote
  | MdastCode
  | MdastList
  | MdastListItem
  | MdastThematicBreak
  | MdastJsxFlow
  | MdastUnknown;
export type MdastInline =
  | MdastText
  | MdastStrong
  | MdastEmphasis
  | MdastInlineCode
  | MdastLink
  | MdastBreak
  | MdastImage
  | MdastJsxText
  | MdastUnknown;

export interface MdastText {
  type: "text";
  value: string;
}

export interface MdastStrong {
  type: "strong";
  children: MdastInline[];
}

export interface MdastEmphasis {
  type: "emphasis";
  children: MdastInline[];
}

export interface MdastInlineCode {
  type: "inlineCode";
  value: string;
}

export interface MdastLink {
  type: "link";
  url: string;
  title: string | null;
  children: MdastInline[];
}

export interface MdastBreak {
  type: "break";
}

export interface MdastImage {
  type: "image";
  url: string;
  alt: string | null;
  title: string | null;
}

export interface MdastParagraph {
  type: "paragraph";
  children: MdastInline[];
}

export interface MdastHeading {
  type: "heading";
  depth: number;
  children: MdastInline[];
}

export interface MdastBlockquote {
  type: "blockquote";
  children: MdastBlock[];
}

export interface MdastCode {
  type: "code";
  lang: string | null;
  value: string;
}

export interface MdastList {
  type: "list";
  ordered: boolean;
  start?: number;
  spread: boolean;
  children: MdastListItem[];
}

export interface MdastListItem {
  type: "listItem";
  spread: boolean;
  children: MdastBlock[];
}

export interface MdastThematicBreak {
  type: "thematicBreak";
}

export interface MdxJsxAttributeValueExpression {
  type: "mdxJsxAttributeValueExpression";
  value: string;
  data?: { estree?: unknown };
}

export type MdxJsxAttribute =
  | { type: "mdxJsxAttribute"; name: string; value: string | null | MdxJsxAttributeValueExpression }
  | { type: "mdxJsxExpressionAttribute"; value?: string }
  | { type: "mdxJsxSpreadAttribute"; value?: string };

export interface MdastJsxFlow {
  type: "mdxJsxFlowElement";
  name: string | null;
  attributes: MdxJsxAttribute[];
  children: MdastBlock[];
}

export interface MdastJsxText {
  type: "mdxJsxTextElement";
  name: string | null;
  attributes: MdxJsxAttribute[];
  children: MdastInline[];
}

export interface MdastUnknown {
  type: string;
  value?: string;
  children?: unknown[];
  position?: SourcePosition;
  [key: string]: unknown;
}

interface SourcePosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
