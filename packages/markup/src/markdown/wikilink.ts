/** Remark syntax extension for Meridian's unlabeled `[[target]]` wikilinks. */

import type {
  CompileContext,
  Extension as FromMarkdownExtension,
  Handle as FromMarkdownHandle,
} from "mdast-util-from-markdown";
import type {
  Options as ToMarkdownExtension,
  Handle as ToMarkdownHandle,
} from "mdast-util-to-markdown";
import type {
  Code,
  Effects,
  Extension as MicromarkExtension,
  State,
  Token,
} from "micromark-util-types";
import type { Plugin } from "unified";

import type { MdastWikiLink } from "../ast.js";
import { skipBalanced, tryConsumeJsxTag } from "../escape.js";
import { closesFence, openingFenceAt } from "./container.js";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    wikiLink: "wikiLink";
    wikiLinkMarker: "wikiLinkMarker";
    wikiLinkTarget: "wikiLinkTarget";
  }
}

const LEFT_BRACKET = 91;
const RIGHT_BRACKET = 93;
const PIPE = 124;
const WIKILINK_SPACE_REFERENCE = "&#x20;";
const WIKILINK_TAB_REFERENCE = "&#x9;";

const tokenizeWikiLink = (effects: Effects, ok: State, nok: State): State => {
  let targetSize = 0;
  let hasNonSpace = false;

  return openFirst;

  function openFirst(code: Code): State | undefined {
    effects.enter("wikiLink");
    effects.enter("wikiLinkMarker");
    effects.consume(code);
    return openSecond;
  }

  function openSecond(code: Code): State | undefined {
    if (code !== LEFT_BRACKET) return nok(code);
    effects.consume(code);
    effects.exit("wikiLinkMarker");
    effects.enter("wikiLinkTarget");
    return target;
  }

  function target(code: Code): State | undefined {
    if (code === null || code === -4 || code === -3 || code === -2 || code === PIPE) {
      return nok(code);
    }
    if (code === RIGHT_BRACKET) {
      if (targetSize === 0 || !hasNonSpace) return nok(code);
      effects.exit("wikiLinkTarget");
      effects.enter("wikiLinkMarker");
      effects.consume(code);
      return closeSecond;
    }
    targetSize += 1;
    if (code !== 32) hasNonSpace = true;
    effects.consume(code);
    return target;
  }

  function closeSecond(code: Code): State | undefined {
    if (code !== RIGHT_BRACKET) return nok(code);
    effects.consume(code);
    effects.exit("wikiLinkMarker");
    effects.exit("wikiLink");
    return ok;
  }
};

function micromarkWikiLink(): MicromarkExtension {
  return {
    text: {
      [LEFT_BRACKET]: {
        name: "wikiLink",
        tokenize: tokenizeWikiLink,
      },
    },
  };
}

const enterWikiLink: FromMarkdownHandle = function (this: CompileContext, token: Token) {
  this.enter({ type: "wikiLink", target: "", children: [] } as never, token);
};

const enterWikiLinkTarget: FromMarkdownHandle = function (this: CompileContext, token: Token) {
  this.config.enter.data?.call(this, token);
};

const exitWikiLinkTarget: FromMarkdownHandle = function (this: CompileContext, token: Token) {
  const node = this.stack[this.stack.length - 2] as unknown as MdastWikiLink;
  this.config.exit.data?.call(this, token);
  const text = node.children[0];
  const target =
    text?.type === "text" && typeof text.value === "string"
      ? text.value
      : this.sliceSerialize(token);
  node.target = target.trim();
  if (text?.type === "text") text.value = node.target;
};

const exitWikiLink: FromMarkdownHandle = function (this: CompileContext, token: Token) {
  this.exit(token);
};

function fromMarkdownWikiLink(): FromMarkdownExtension {
  return {
    enter: {
      wikiLink: enterWikiLink,
      wikiLinkTarget: enterWikiLinkTarget,
    },
    exit: {
      wikiLinkTarget: exitWikiLinkTarget,
      wikiLink: exitWikiLink,
    },
  };
}

const handleWikiLink: ToMarkdownHandle = (node) => {
  const target = (node as unknown as MdastWikiLink).target;
  return `[[${target}]]`;
};

function toMarkdownWikiLink(): ToMarkdownExtension {
  return {
    unsafe: [{ character: "[", after: "\\[", inConstruct: "phrasing" }],
    handlers: { wikiLink: handleWikiLink } as ToMarkdownExtension["handlers"],
  };
}

export const remarkWikiLink: Plugin = function () {
  const data = this.data();
  if (!data.micromarkExtensions) data.micromarkExtensions = [] as MicromarkExtension[];
  if (!data.fromMarkdownExtensions) data.fromMarkdownExtensions = [] as FromMarkdownExtension[];
  if (!data.toMarkdownExtensions) data.toMarkdownExtensions = [] as ToMarkdownExtension[];

  data.micromarkExtensions.push(micromarkWikiLink());
  data.fromMarkdownExtensions.push(fromMarkdownWikiLink());
  data.toMarkdownExtensions.push(toMarkdownWikiLink());
};

export function normalizeLabeledWikilinkDestinations(
  source: string,
  options: { protectMdxSyntax?: boolean } = {},
): string {
  // CommonMark refuses whitespace in a raw link destination. Character
  // references let its parser recover the intended href without changing the
  // target held by the ProseMirror link mark.
  return rewriteLabeledWikilinkDestinations(
    source,
    (target) => {
      const canonicalTarget = target.trim();
      return canonicalTarget
        .replaceAll(" ", WIKILINK_SPACE_REFERENCE)
        .replaceAll("\t", WIKILINK_TAB_REFERENCE);
    },
    options,
  );
}

export function canonicalizeLabeledWikilinkDestinations(
  source: string,
  options: { protectMdxSyntax?: boolean } = {},
): string {
  return rewriteLabeledWikilinkDestinations(source, (target) => target.trim(), {
    ...options,
    acceptEscapedOpening: true,
    acceptLiteralDestination: true,
  });
}

interface RewriteOptions {
  acceptEscapedOpening?: boolean;
  acceptLiteralDestination?: boolean;
  protectMdxSyntax?: boolean;
}

function rewriteLabeledWikilinkDestinations(
  source: string,
  rewriteTarget: (target: string) => string,
  options: RewriteOptions = {},
): string {
  const lines = source.split("\n");
  let fence: { marker: string; length: number } | null = null;
  let codeSpanTicks = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    if (fence) {
      if (closesFence(lines, lineIndex, fence)) fence = null;
      continue;
    }

    if (codeSpanTicks === 0) {
      const openingFence = openingFenceAt(lines, lineIndex);
      if (openingFence) {
        fence = openingFence;
        continue;
      }
    }

    const rewritten = rewriteLine(lines, lineIndex, codeSpanTicks, rewriteTarget, options);
    lines[lineIndex] = rewritten.value;
    codeSpanTicks = rewritten.codeSpanTicks;
  }

  return lines.join("\n");
}

function rewriteLine(
  lines: readonly string[],
  lineIndex: number,
  initialCodeSpanTicks: number,
  rewriteTarget: (target: string) => string,
  options: RewriteOptions,
): { value: string; codeSpanTicks: number } {
  let value = lines[lineIndex] ?? "";
  let codeSpanTicks = initialCodeSpanTicks;

  for (let index = 0; index < value.length; index++) {
    if (codeSpanTicks === 0 && options.protectMdxSyntax) {
      const protectedLength =
        value[index] === "<"
          ? tryConsumeJsxTag(value, index)
          : value[index] === "{"
            ? balancedSpanLength(value, index, "{", "}")
            : null;
      if (protectedLength !== null) {
        index += protectedLength - 1;
        continue;
      }
    }
    if (value[index] === "`" && !isEscaped(value, index)) {
      const ticks = markerRunLength(value, index, "`");
      if (codeSpanTicks === 0 && hasClosingCodeSpan(lines, lineIndex, index + ticks, ticks)) {
        codeSpanTicks = ticks;
      } else if (codeSpanTicks === ticks) codeSpanTicks = 0;
      index += ticks - 1;
      continue;
    }
    if (codeSpanTicks !== 0 || value[index] !== "]") continue;

    const destination = labeledWikilinkDestinationAt(value, index, options);
    if (!destination) continue;
    const rewrittenTarget = rewriteTarget(destination.target);
    const replacement = `([[${rewrittenTarget}]]`;
    value = `${value.slice(0, index + 1)}${replacement}${value.slice(destination.end)}`;
    index += replacement.length;
  }

  return { value, codeSpanTicks };
}

function balancedSpanLength(
  value: string,
  start: number,
  open: string,
  close: string,
): number | null {
  const end = skipBalanced(value, start, open, close);
  return end === null ? null : end - start;
}

function hasClosingCodeSpan(
  lines: readonly string[],
  openingLine: number,
  openingEnd: number,
  ticks: number,
): boolean {
  const marker = "`".repeat(ticks);
  for (let lineIndex = openingLine; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    if (lineIndex > openingLine && line.trim().length === 0) return false;
    let index = lineIndex === openingLine ? openingEnd : 0;
    index = line.indexOf(marker, index);
    while (index !== -1) {
      if (markerRunLength(line, index, "`") === ticks && !isEscaped(line, index)) {
        return true;
      }
      index += marker.length;
      index = line.indexOf(marker, index);
    }
  }
  return false;
}

function labeledWikilinkDestinationAt(
  value: string,
  labelEnd: number,
  options: RewriteOptions,
): { target: string; end: number } | null {
  if (value[labelEnd + 1] !== "(" || !hasLabelOpening(value, labelEnd)) return null;

  let index = labelEnd + 2;
  const literal = options.acceptLiteralDestination && value[index] === "<";
  if (literal) index++;

  const escapedOpening = options.acceptEscapedOpening && value.startsWith("\\[\\[", index);
  if (escapedOpening) index += 4;
  else if (value.startsWith("[[", index)) index += 2;
  else return null;

  const targetEnd = value.indexOf("]]", index);
  if (targetEnd === -1) return null;
  const target = value.slice(index, targetEnd);
  if (target.trim().length === 0 || /[\r\n\]|]/.test(target)) return null;

  index = targetEnd + 2;
  if (literal) {
    if (value[index] !== ">") return null;
    index++;
  }
  if (value[index] !== ")" && !/[ \t]/.test(value[index] ?? "")) return null;
  return { target, end: index };
}

function hasLabelOpening(value: string, labelEnd: number): boolean {
  let depth = 1;
  for (let index = labelEnd - 1; index >= 0; index--) {
    if (isEscaped(value, index)) continue;
    if (value[index] === "]") depth++;
    else if (value[index] === "[") {
      depth--;
      if (depth === 0) return true;
    }
  }
  return false;
}

function markerRunLength(value: string, start: number, marker: string): number {
  let end = start + 1;
  while (value[end] === marker) end++;
  return end - start;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  while (index > 0 && value[--index] === "\\") backslashes++;
  return backslashes % 2 === 1;
}
