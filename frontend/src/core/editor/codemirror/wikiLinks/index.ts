/**
 * Wiki-Links Module
 *
 * Document editor @-references stored as `@[[path | name]]` markdown syntax,
 * rendered as styled inline text with Obsidian-style cursor reveal.
 *
 * Decorations are provided via `wikiLinkScanner` (InlineScanner), coordinated
 * by the live preview plugin. Interaction handlers (click, clipboard) are
 * separate CM6 extensions.
 */

export {
  createWikiLinkClickHandler,
  createWikiLinkClipboardHandler,
} from "./wikiLinkPlugin";
export { wikiLinkScanner } from "./wikiLinkScanner";
export { insertWikiLink } from "./wikiLinkInsertion";
export {
  WIKI_LINK_PATTERN,
  findWikiLinks,
  pathToDisplayName,
} from "./wikiLinkRegex";
export {
  buildMeridianClipboardFromWikiText,
  ensureReferenceClipboardCodecRegistered,
  formatWikiLink,
  meridianPayloadToWikiLinkText,
} from "./clipboardInterop";
export {
  resolveDocumentByPath,
  resolveDocumentPathById,
} from "./resolveDocument";
