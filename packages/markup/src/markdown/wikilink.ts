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

const tokenizeWikiLink = (effects: Effects, ok: State, nok: State): State => {
  let targetSize = 0;

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
      if (targetSize === 0) return nok(code);
      effects.exit("wikiLinkTarget");
      effects.enter("wikiLinkMarker");
      effects.consume(code);
      return closeSecond;
    }
    targetSize += 1;
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
  node.target = this.sliceSerialize(token);
  this.config.exit.data?.call(this, token);
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
