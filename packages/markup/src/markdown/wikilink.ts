/** Remark syntax for Meridian wikilinks and wikilink-valued resources. */

import type {
  CompileContext,
  Extension as FromMarkdownExtension,
  Handle as FromMarkdownHandle,
  Transform as FromMarkdownTransform,
} from "mdast-util-from-markdown";
import type {
  Options as ToMarkdownExtension,
  Handle as ToMarkdownHandle,
  State as ToMarkdownState,
} from "mdast-util-to-markdown";
import { labelEnd } from "micromark-core-commonmark";
import { factoryTitle } from "micromark-factory-title";
import { factoryWhitespace } from "micromark-factory-whitespace";
import { markdownLineEnding, markdownLineEndingOrSpace } from "micromark-util-character";
import type {
  Code,
  Construct,
  Extension as MicromarkExtension,
  State,
  Token,
  Tokenizer,
} from "micromark-util-types";
import type { Plugin } from "unified";

import type { MdastWikiLink, MdastWikiLinkImage, MdastWikiLinkResource } from "../ast.js";

// These resource nodes keep a wikilink target opaque. CommonMark otherwise
// decodes character references in destinations, changing `A&amp;B` to `A&B`.
declare module "micromark-util-types" {
  interface TokenTypeMap {
    wikiLink: "wikiLink";
    wikiLinkMarker: "wikiLinkMarker";
    wikiLinkTarget: "wikiLinkTarget";
    wikiLinkResourceTarget: "wikiLinkResourceTarget";
  }
}

const LEFT_PARENTHESIS = 40;
const RIGHT_PARENTHESIS = 41;
const DOUBLE_QUOTE = 34;
const APOSTROPHE = 39;
const LEFT_BRACKET = 91;
const RIGHT_BRACKET = 93;
const PIPE = 124;

const tokenizeWikiLink: Tokenizer = (effects, ok, nok) => {
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
    if (code === null || markdownLineEnding(code) || code === -2 || code === PIPE) {
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

const tokenizeWikiLinkResourceEnd: Tokenizer = function (effects, ok, nok) {
  type LabelToken = Token & { _balanced?: boolean; _inactive?: boolean };
  let labelStart: LabelToken | undefined;
  let targetSize = 0;
  let hasNonSpace = false;

  for (let index = this.events.length - 1; index >= 0; index--) {
    const token = this.events[index]?.[1] as LabelToken | undefined;
    if (token && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
      labelStart = token;
      break;
    }
  }

  return labelClose;

  function labelClose(code: Code): State | undefined {
    if (code !== RIGHT_BRACKET || !labelStart || labelStart._inactive) return nok(code);
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return resourceOpen;
  }

  function resourceOpen(code: Code): State | undefined {
    if (code !== LEFT_PARENTHESIS) return nok(code);
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code);
    effects.exit("resourceMarker");
    effects.enter("resourceDestination");
    effects.enter("wikiLinkMarker");
    return targetOpenFirst;
  }

  function targetOpenFirst(code: Code): State | undefined {
    if (code !== LEFT_BRACKET) return nok(code);
    effects.consume(code);
    return targetOpenSecond;
  }

  function targetOpenSecond(code: Code): State | undefined {
    if (code !== LEFT_BRACKET) return nok(code);
    effects.consume(code);
    effects.exit("wikiLinkMarker");
    effects.enter("wikiLinkResourceTarget");
    return target;
  }

  function target(code: Code): State | undefined {
    if (code === null || markdownLineEnding(code) || code === -2 || code === PIPE) {
      return nok(code);
    }
    if (code === RIGHT_BRACKET) {
      if (targetSize === 0 || !hasNonSpace) return nok(code);
      effects.exit("wikiLinkResourceTarget");
      effects.enter("wikiLinkMarker");
      effects.consume(code);
      return targetCloseSecond;
    }
    targetSize += 1;
    if (code !== 32) hasNonSpace = true;
    effects.consume(code);
    return target;
  }

  function targetCloseSecond(code: Code): State | undefined {
    if (code !== RIGHT_BRACKET) return nok(code);
    effects.consume(code);
    effects.exit("wikiLinkMarker");
    effects.exit("resourceDestination");
    return resourceDestinationAfter;
  }

  function resourceDestinationAfter(code: Code): State | undefined {
    return markdownLineEndingOrSpace(code)
      ? factoryWhitespace(effects, resourceBetween)(code)
      : resourceEnd(code);
  }

  function resourceBetween(code: Code): State | undefined {
    if (code === DOUBLE_QUOTE || code === APOSTROPHE || code === LEFT_PARENTHESIS) {
      return factoryTitle(
        effects,
        resourceTitleAfter,
        nok,
        "resourceTitle",
        "resourceTitleMarker",
        "resourceTitleString",
      )(code);
    }
    return resourceEnd(code);
  }

  function resourceTitleAfter(code: Code): State | undefined {
    return markdownLineEndingOrSpace(code)
      ? factoryWhitespace(effects, resourceEnd)(code)
      : resourceEnd(code);
  }

  function resourceEnd(code: Code): State | undefined {
    if (code !== RIGHT_PARENTHESIS) return nok(code);
    effects.enter("resourceMarker");
    effects.consume(code);
    effects.exit("resourceMarker");
    effects.exit("resource");
    return ok;
  }
};

const wikiLinkResourceEnd: Construct = {
  name: "wikiLinkResourceEnd",
  resolveAll: labelEnd.resolveAll,
  resolveTo: labelEnd.resolveTo,
  tokenize: tokenizeWikiLinkResourceEnd,
};

function micromarkWikiLink(): MicromarkExtension {
  return {
    text: {
      [LEFT_BRACKET]: {
        name: "wikiLink",
        tokenize: tokenizeWikiLink,
      },
      [RIGHT_BRACKET]: wikiLinkResourceEnd,
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

const exitWikiLinkResourceTarget: FromMarkdownHandle = function (
  this: CompileContext,
  token: Token,
) {
  const node = this.stack[this.stack.length - 1] as unknown as {
    target: string;
    url?: string;
  };
  node.target = this.sliceSerialize(token).trim();
  delete node.url;
};

function fromMarkdownWikiLink(): FromMarkdownExtension {
  return {
    enter: {
      wikiLink: enterWikiLink,
      wikiLinkTarget: enterWikiLinkTarget,
    },
    exit: {
      wikiLinkTarget: exitWikiLinkTarget,
      wikiLinkResourceTarget: exitWikiLinkResourceTarget,
      wikiLink: exitWikiLink,
    },
    transforms: [promoteWikiLinkResources],
  };
}

const promoteWikiLinkResources: FromMarkdownTransform = (tree) => {
  promoteWikiLinkResourceNodes(tree);
  return tree;
};

function promoteWikiLinkResourceNodes(tree: unknown): void {
  const record = tree as { type?: string; target?: string; children?: unknown[] };
  if ((record.type === "link" || record.type === "image") && typeof record.target === "string") {
    record.type = record.type === "image" ? "wikiLinkImage" : "wikiLinkResource";
  }
  for (const child of record.children ?? []) promoteWikiLinkResourceNodes(child);
}

const handleWikiLink: ToMarkdownHandle = (node) => {
  const target = (node as unknown as MdastWikiLink).target;
  return `[[${target}]]`;
};

const handleWikiLinkResource: ToMarkdownHandle = (node, _parent, state, info) => {
  const resource = node as unknown as MdastWikiLinkResource;
  const tracker = state.createTracker(info);
  const exitLink = state.enter("link");
  const exitLabel = state.enter("label");
  let value = tracker.move("[");
  value += tracker.move(
    state.containerPhrasing(resource as never, {
      before: value,
      after: "](",
      ...tracker.current(),
    }),
  );
  value += tracker.move("](");
  exitLabel();
  value += tracker.move(`[[${resource.target}]]`);
  value += serializeTitle(resource.title, state, tracker, value);
  value += tracker.move(")");
  exitLink();
  return value;
};

const handleWikiLinkImage: ToMarkdownHandle = (node, _parent, state, info) => {
  const image = node as unknown as MdastWikiLinkImage;
  const tracker = state.createTracker(info);
  const exitImage = state.enter("image");
  const exitLabel = state.enter("label");
  let value = tracker.move("![");
  value += tracker.move(state.safe(image.alt, { before: value, after: "]", ...tracker.current() }));
  value += tracker.move("](");
  exitLabel();
  value += tracker.move(`[[${image.target}]]`);
  value += serializeTitle(image.title, state, tracker, value);
  value += tracker.move(")");
  exitImage();
  return value;
};

function serializeTitle(
  title: string | null,
  state: ToMarkdownState,
  tracker: ReturnType<ToMarkdownState["createTracker"]>,
  before: string,
): string {
  if (title === null) return "";
  const quote = state.options.quote === "'" ? "'" : '"';
  const exitTitle = state.enter(quote === '"' ? "titleQuote" : "titleApostrophe");
  let value = tracker.move(` ${quote}`);
  value += tracker.move(
    state.safe(title, { before: before + value, after: quote, ...tracker.current() }),
  );
  value += tracker.move(quote);
  exitTitle();
  return value;
}

function toMarkdownWikiLink(): ToMarkdownExtension {
  return {
    unsafe: [{ character: "[", after: "\\[", inConstruct: "phrasing" }],
    handlers: {
      wikiLink: handleWikiLink,
      wikiLinkResource: handleWikiLinkResource,
      wikiLinkImage: handleWikiLinkImage,
    } as ToMarkdownExtension["handlers"],
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
