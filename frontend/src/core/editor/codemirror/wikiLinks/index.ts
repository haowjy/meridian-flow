/**
 * Wiki-Links Module
 *
 * Document editor @-references stored as `@[[path | name]]` markdown syntax,
 * rendered as styled inline text with Obsidian-style cursor reveal.
 */

export {
  createWikiLinkPlugin,
  createWikiLinkClickHandler,
  createWikiLinkClipboardHandler,
} from "./wikiLinkPlugin";
export { insertWikiLink } from "./wikiLinkInsertion";
export {
  WIKI_LINK_PATTERN,
  findWikiLinks,
  pathToDisplayName,
} from "./wikiLinkRegex";
export { RefIconWidget } from "./WikiLinkWidget";
export type { PillAIChangeType } from "./WikiLinkWidget";
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
