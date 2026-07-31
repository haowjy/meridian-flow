/**
 * The composer's `@`, riding the same Suggestion machinery as the manuscript.
 *
 * The textarea adapter this replaces had to detect the token, measure the
 * caret, and splice the pick by hand; a TipTap input gets all three from
 * `@tiptap/suggestion`, the same utility under the editor's `@` and `[[`.
 * What a query means stays [`@/core/references`](../../../core/references/index.ts),
 * what an open menu does with a key stays
 * [`@/core/completion`](../../../core/completion/index.ts); this file declares
 * only the composer's own answers: documents alone, no create row, and a pick
 * that inserts an atomic reference token rather than splicing text.
 *
 * **Not the editor's suggestion lane**, deliberately. `createSuggestionLane`
 * binds its keys through the editor chrome kernel, which the composer does not
 * mount — the composer enforces menu-owns-keys itself in `handleKeyDown`, at
 * the same spot it arbitrates Enter between the menu, a hard break, and a sent
 * message. The lane's other jobs (catalog fence, dismissal mapping) are small
 * enough to carry here without inheriting a chrome the message box has no use
 * for.
 *
 * **No create row.** The engine offers one wherever a document scope can make
 * a page, and the composer declines it: a message that names a chapter nobody
 * has written is a perfectly good message, but a row promising to CREATE one
 * from the chat box would either lie or do something the writer did not ask
 * for. An empty list then closes the menu, the same law that leaves a writer
 * alone with an `@` nothing matched.
 */

import type { Editor, Range } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

import {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuController,
  type SuggestionMenuSession,
  type SuggestionMenuSnapshot,
} from "@/core/completion";
import { allowsProseTrigger, atWordBoundary } from "@/core/editor/extensions/suggestion";
import {
  filterReferenceItems,
  type ReferenceCatalog,
  type ReferenceDocumentItem,
  referenceSpelling,
} from "@/core/references";

import { REFERENCE_TOKEN_NODE, type ReferenceTokenAttributes } from "./reference-token";

const EXTENSION_NAME = "composerReferenceSuggestion";

const pluginKey = new PluginKey(EXTENSION_NAME);
const catalogFencePluginKey = new PluginKey(`${EXTENSION_NAME}CatalogFence`);

/** Documents alone: the composer's `@` names pages, not pictures (yet). */
const DOCUMENT_SCOPE = ["document"] as const;

/**
 * A query that opens with a space is not a name — "meet @ noon" is the writer's
 * own sentence. Same refusal as the editor's `@` (`at-reference-catalog.ts`).
 */
const NOT_A_NAME = /^\s/u;

export type ComposerReferenceOptions = {
  /** Null outside a project, where nothing internal can be named. */
  catalog: () => ReferenceCatalog | null;
};

type ComposerReferenceStorage = {
  menu: SuggestionMenu<ReferenceDocumentItem>;
  /** @internal driven by this extension's plugin and blur handling only. */
  controller: SuggestionMenuController<ReferenceDocumentItem>;
};

function composerReferenceItems(catalog: ReferenceCatalog, query: string): ReferenceDocumentItem[] {
  if (NOT_A_NAME.test(query)) return [];
  return filterReferenceItems(catalog.candidates, DOCUMENT_SCOPE, query).filter(
    (item): item is ReferenceDocumentItem => item.kind === "document",
  );
}

/**
 * What a pick writes: one atomic token, never spliced text. A trailing space
 * rides along unless the message already has one there — every mention surface
 * a writer arrives from adds it, and the alternative is a caret pressed
 * against a pill that the next word would run into.
 */
export function insertComposerReference(
  editor: Editor,
  range: Range,
  item: ReferenceDocumentItem,
): boolean {
  const attrs: ReferenceTokenAttributes = {
    kind: "document",
    documentId: item.documentId,
    uri: item.uri,
    label: item.name,
    spelling: referenceSpelling(item),
  };
  const next = editor.state.doc.resolve(
    Math.min(range.to, editor.state.doc.content.size),
  ).nodeAfter;
  const alreadySpaced = next?.isText
    ? /^\s/.test(next.text ?? "")
    : next?.type.name === "hard_break";
  const spaced = alreadySpaced ? [] : [{ type: "text", text: " " }];
  return editor
    .chain()
    .focus()
    .insertContentAt(range, [{ type: REFERENCE_TOKEN_NODE, attrs }, ...spaced])
    .run();
}

export const ComposerReferenceExtension = Extension.create<
  ComposerReferenceOptions,
  ComposerReferenceStorage
>({
  name: EXTENSION_NAME,

  addOptions() {
    return { catalog: () => null };
  },

  addStorage() {
    return createSuggestionMenu<ReferenceDocumentItem>();
  },

  // A composer nobody is typing in has no menu. Closed rather than dismissed:
  // nothing about the `@` changed, so coming back and touching the draft
  // brings the menu back — the suggestion session is still live underneath.
  // (Choosing a row never lands here: the rows cancel their own mousedown.)
  onBlur() {
    this.storage.controller.close();
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const { controller } = this.storage;

    const sessionFrom = (
      props: SuggestionProps<ReferenceDocumentItem>,
    ): SuggestionMenuSession<ReferenceDocumentItem> | null => {
      const catalog = options.catalog();
      if (!catalog) return null;
      return {
        items: props.items,
        query: props.query,
        anchorRect: props.clientRect ?? (() => null),
        label: catalog.label,
        meta: null,
        choose: (item) => props.command(item),
        dismiss: () => exitSuggestion(editor.view, pluginKey),
      };
    };

    return [
      Suggestion<ReferenceDocumentItem>({
        editor,
        pluginKey,
        char: "@",
        // Document titles have spaces in them; a menu that stopped filtering
        // at "The Second" could never find "The Second Gate". The cost is paid
        // by the empty-list-closes rule.
        allowSpaces: true,
        startOfLine: false,
        allowedPrefixes: null,
        // The word boundary is what makes email addresses safe: an address's
        // `@` always follows a letter, a writer naming a chapter never types
        // one there. Same envelope as the editor's `@`.
        allow: ({ state, range }) =>
          options.catalog() !== null &&
          allowsProseTrigger(state.doc, range.from) &&
          atWordBoundary(state.doc, range.from),
        items: ({ query }) => {
          const catalog = options.catalog();
          return catalog ? composerReferenceItems(catalog, query) : [];
        },
        command: ({ editor: target, range, props }) => {
          if (!options.catalog()) {
            // Withdrawn between the row being drawn and the row being chosen:
            // take the menu down rather than write from a dead list.
            exitSuggestion(target.view, pluginKey);
            return;
          }
          insertComposerReference(target, range, props);
        },
        render: () => ({
          onStart(props) {
            const session = sessionFrom(props);
            if (session) controller.open(session);
          },
          onUpdate(props) {
            const session = sessionFrom(props);
            if (session) controller.update(session);
          },
          onExit() {
            controller.close();
          },
        }),
      }),

      // The catalog can be withdrawn without a transaction to notice it (the
      // project navigated away from under an open menu). Exiting here means
      // withdrawal leaves by the same door as Escape.
      new Plugin({
        key: catalogFencePluginKey,
        view: (view) => ({
          update() {
            if (!pluginKey.getState(view.state)?.active) return;
            if (options.catalog() === null) exitSuggestion(view, pluginKey);
          },
        }),
      }),
    ];
  },
});

const CLOSED = closedSuggestionMenu<ReferenceDocumentItem>();

/** The composer's open menu, or a closed reading before the editor exists. */
export function getComposerReferenceMenu(
  editor: Editor | null | undefined,
): SuggestionMenu<ReferenceDocumentItem> | null {
  if (!editor || editor.isDestroyed) return null;
  const storage = editor.storage as unknown as Record<string, ComposerReferenceStorage | undefined>;
  return storage[EXTENSION_NAME]?.menu ?? null;
}

export function closedComposerReferenceMenu(): SuggestionMenuSnapshot<ReferenceDocumentItem> {
  return CLOSED;
}
