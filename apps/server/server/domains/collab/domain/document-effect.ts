/** Compares visible document effects, independent of Yjs history and review coverage. */
import { isDeepStrictEqual } from "node:util";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export function documentEffectsEqual(live: Y.Doc, draft: Y.Doc): boolean {
  return isDeepStrictEqual(
    visibleContent(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
    visibleContent(draft.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME)),
  );
}

function visibleContent(node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook): unknown {
  if (node instanceof Y.XmlHook) return { hook: node.hookName, values: node.toJSON() };
  if (node instanceof Y.XmlText) return { text: node.toDelta() };
  return {
    ...(node instanceof Y.XmlElement
      ? { type: node.nodeName, attributes: node.getAttributes() }
      : {}),
    children: node.toArray().map(visibleContent),
  };
}
