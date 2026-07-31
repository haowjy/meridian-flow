/**
 * The href field's completion offer: the Mod-K form driving the same engine
 * the composer and the manuscript do.
 *
 * The field is location-triggered — no `@`, no `[[`: being the href slot is
 * the trigger, and typing is the query (§Href-slot completion). What a query
 * means is [`@/core/references`](../../../../core/references/index.ts); what
 * an open menu does with a key is `@/core/completion`; this hook owns only
 * what the field has to answer for itself: when to offer, when to step aside,
 * and what a pick writes.
 *
 * **A pick fills the canonical scheme URI, not `[[Title]]`.** The href slot
 * exists because display text differs from the target; the candidate already
 * carries a stable URI, and spelling the title back would throw that identity
 * away for a name two documents may share.
 *
 * **The offer steps aside, it never gates.** While `looksExplicitlyExternal`
 * is false the candidates stay offered; the moment the writer unambiguously
 * starts a URL the menu closes and the form is exactly what it was before
 * this hook existed. An empty field offers nothing either, because Enter in
 * an emptied field means "remove the link" and a menu over it would spend
 * that keystroke on a pick.
 *
 * **The open menu is a chrome layer of its own**, nested inside the form's.
 * That is how it owns its keys without racing anyone for them: the kernel's
 * document listener runs the layer's bindings before Radix's Escape listener
 * can dismiss the form, so ArrowUp/ArrowDown/Enter belong to the menu while
 * it is open, Escape walks one step home (menu closes, form stays), and a
 * closed menu claims nothing — Enter submits, Escape dismisses the form
 * (§Trigger-composition 2). A local `document` listener would answer the same
 * keys invisibly to the Esc chain, which is exactly what the keymap seam is
 * there to prevent.
 *
 * **No create row.** A form field is not a place to conjure documents: the
 * writer is naming a target, and a row that made one would either lie or act
 * unasked. Same law as the composer; the empty list then closes the menu.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { type RefObject, useCallback, useRef, useState, useSyncExternalStore } from "react";

import {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuSnapshot,
} from "@/core/completion";
import { looksExplicitlyExternal } from "@/core/links";
import { filterReferenceItems, type ReferenceDocumentItem } from "@/core/references";
import { useReferenceCandidates } from "@/features/project/context/useReferenceCandidates";

import { useChromeLayer } from "../../chrome";
import { useEditorScope } from "../../editor-scope";

const DOCUMENT_SCOPE = ["document"] as const;

const closed = () => closedSuggestionMenu<ReferenceDocumentItem>();

export type HrefReferencesOptions = {
  editor: Editor;
  /** The href input, which is the menu's anchor — no caret mirror needed. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** Writes the picked document's canonical URI into the field. */
  onFill: (uri: string) => void;
};

export type HrefReferences = {
  menu: SuggestionMenu<ReferenceDocumentItem>;
  snapshot: SuggestionMenuSnapshot<ReferenceDocumentItem>;
  /** Re-offers for what the field holds now; call on every input. */
  sync: (value: string) => void;
  /** Takes the menu down without ceremony, for a field the writer left. */
  close: () => void;
};

export function useHrefReferences({
  editor,
  inputRef,
  onFill,
}: HrefReferencesOptions): HrefReferences {
  const { projectId, workId } = useEditorScope();
  const { candidates } = useReferenceCandidates({ projectId, workId });
  const [store] = useState(() => createSuggestionMenu<ReferenceDocumentItem>());
  const snapshot = useSyncExternalStore(store.menu.subscribe, store.menu.snapshot, closed);

  const latest = useRef({ candidates, onFill });
  latest.current = { candidates, onFill };

  const sync = useCallback(
    (value: string) => {
      // No project means nothing internal to name; an explicit URL means the
      // writer is somewhere else entirely. Either way the menu steps aside.
      if (!projectId || looksExplicitlyExternal(value)) {
        store.controller.close();
        return;
      }
      // The placeholder teaches `[[a document name]]`, so a writer typing that
      // spelling by hand still gets the offer: the brackets are how they are
      // asking, not part of the name.
      const query = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
      if (!query) {
        store.controller.close();
        return;
      }

      const items = filterReferenceItems(latest.current.candidates, DOCUMENT_SCOPE, query).filter(
        (item): item is ReferenceDocumentItem => item.kind === "document",
      );

      const open = store.menu.snapshot().open;
      const session = {
        items,
        query,
        anchorRect: () => inputRef.current?.getBoundingClientRect() ?? null,
        label: t`Reference a document`,
        meta: null,
        choose: (item: ReferenceDocumentItem) => {
          latest.current.onFill(item.uri);
          store.controller.close();
        },
        dismiss: () => store.controller.close(),
      };
      if (open) store.controller.update(session);
      else store.controller.open(session);
    },
    [inputRef, projectId, store],
  );

  const close = useCallback(() => store.controller.close(), [store]);

  // Escape is not in `keys`, deliberately: the layer's kernel dismissal IS the
  // Escape handling, and a binding of our own would spend the key twice.
  useChromeLayer(editor, {
    id: "link-href-references",
    open: snapshot.open,
    close: () => store.menu.dismiss(),
    keys: {
      ArrowDown: () => store.menu.move(1),
      ArrowUp: () => store.menu.move(-1),
      Enter: () => store.menu.chooseActive(),
    },
  });

  return { menu: store.menu, snapshot, sync, close };
}
