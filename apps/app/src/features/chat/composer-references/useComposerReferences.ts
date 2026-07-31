/**
 * The composer's `@`: a textarea driving the same engine the manuscript does.
 *
 * The editor's triggers ride `@tiptap/suggestion`, which owns detection, the
 * range, and the replace. A textarea has none of that, so this is the adapter
 * that supplies them — and nothing else. What a query means is
 * [`@/core/references`](../../../core/references/index.ts); what an open menu
 * does with a key is [`@/core/completion`](../../../core/completion/index.ts);
 * this file finds the token, measures the caret, and hands a pick back as a
 * new string.
 *
 * **The keys are ours only while the menu is open.** The composer submits on
 * Enter and stops a stream on Escape, so it asks here first: an open menu owns
 * ArrowUp, ArrowDown, Enter and Escape, and a closed one owns nothing
 * (§Trigger-composition 2). Enforced locally, because a textarea has no chrome
 * kernel to register a layer with.
 *
 * **No create row.** The engine offers one wherever a document scope can make a
 * page, and the composer declines it: a message that names a chapter nobody has
 * written is a perfectly good message, but a row promising to CREATE one from
 * the chat box would either lie or do something the writer did not ask for.
 * An empty list then closes the menu, which is the same law that leaves a
 * writer alone with an `@` nothing matched.
 */

import { t } from "@lingui/core/macro";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  closedSuggestionMenu,
  createSuggestionMenu,
  type SuggestionMenu,
  type SuggestionMenuSnapshot,
} from "@/core/completion";
import {
  filterReferenceItems,
  findReferenceToken,
  type ReferenceDocumentItem,
  type ReferenceToken,
  referenceSpelling,
  spliceReference,
} from "@/core/references";
import { useReferenceCandidates } from "@/features/project/context/useReferenceCandidates";

import { caretRect, frameAnchorRect } from "./caret-anchor";

const DOCUMENT_SCOPE = ["document"] as const;

const closed = () => closedSuggestionMenu<ReferenceDocumentItem>();

export type ComposerReferencesOptions = {
  /** Null outside a project, where nothing internal can be named. */
  projectId: string | null;
  /** The Work whose scratch is in reach. */
  workId: string | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer's own box, for the anchor of last resort. */
  frameRef: RefObject<HTMLElement | null>;
  /** Applies a pick: the whole message, and where the caret lands in it. */
  onReplace: (replacement: { text: string; caret: number }) => void;
};

export type ComposerReferences = {
  menu: SuggestionMenu<ReferenceDocumentItem>;
  snapshot: SuggestionMenuSnapshot<ReferenceDocumentItem>;
  /** Where the caret is, or the composer's top edge when it cannot be measured. */
  anchor: DOMRect | null;
  /** Re-reads the token after anything that could have moved the caret. */
  sync: () => void;
  /** True when the menu took the key and the composer must not act on it. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
};

export function useComposerReferences({
  projectId,
  workId,
  textareaRef,
  frameRef,
  onReplace,
}: ComposerReferencesOptions): ComposerReferences {
  const { candidates } = useReferenceCandidates({ projectId, workId });
  const [store] = useState(() => createSuggestionMenu<ReferenceDocumentItem>());
  const snapshot = useSyncExternalStore(store.menu.subscribe, store.menu.snapshot, closed);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const token = useRef<ReferenceToken | null>(null);
  const anchorRef = useRef<DOMRect | null>(null);
  /**
   * The `@` the writer dismissed. Escape leaves the text alone, so the token is
   * still there on the next keystroke and would reopen the menu the writer just
   * closed; it stays shut until they start a different one.
   */
  const dismissed = useRef<number | null>(null);
  const latest = useRef({ candidates, onReplace });
  latest.current = { candidates, onReplace };

  const measure = useCallback(() => {
    const textarea = textareaRef.current;
    const found = token.current;
    const rect =
      textarea && found
        ? // Degraded placement, never a missing menu.
          (caretRect(textarea, found.to) ?? frameAnchorRect(frameRef.current))
        : null;
    anchorRef.current = rect;
    setAnchor((previous) => (sameRect(previous, rect) ? previous : rect));
  }, [frameRef, textareaRef]);

  const sync = useCallback(() => {
    const textarea = textareaRef.current;
    // A selection is not a caret: the writer is picking text out, not typing a
    // name into it. And with no project there is nothing internal to name, so
    // `@` in the Home hero is ordinary prose.
    if (!projectId || !textarea || textarea.selectionStart !== textarea.selectionEnd) {
      token.current = null;
      store.controller.close();
      return;
    }

    const found = findReferenceToken(textarea.value, textarea.selectionStart);
    if (!found) {
      token.current = null;
      dismissed.current = null;
      store.controller.close();
      return;
    }
    if (dismissed.current === found.from) return;

    const had = token.current !== null;
    token.current = found;
    measure();

    const items = filterReferenceItems(
      latest.current.candidates,
      DOCUMENT_SCOPE,
      found.query,
    ).filter((item): item is ReferenceDocumentItem => item.kind === "document");

    const session = {
      items,
      query: found.query,
      anchorRect: () => anchorRef.current,
      label: t`Reference a document`,
      meta: null,
      choose: (item: ReferenceDocumentItem) => {
        const area = textareaRef.current;
        const range = token.current;
        if (!area || !range) return;
        latest.current.onReplace(spliceReference(area.value, range, referenceSpelling(item)));
        token.current = null;
        store.controller.close();
      },
      dismiss: () => {
        dismissed.current = token.current?.from ?? null;
        store.controller.close();
      },
    };
    if (had) store.controller.update(session);
    else store.controller.open(session);
  }, [measure, projectId, store, textareaRef]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!store.menu.snapshot().open) return false;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          return store.menu.move(1);
        case "ArrowUp":
          event.preventDefault();
          return store.menu.move(-1);
        case "Enter":
          // Shift+Enter is a newline in the composer and stays one; a modifier
          // is the writer saying "send it", which the menu does not intercept.
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
          event.preventDefault();
          return store.menu.chooseActive();
        case "Escape":
          event.preventDefault();
          store.menu.dismiss();
          return true;
        default:
          return false;
      }
    },
    [store],
  );

  // The mirror measures the text as it is laid out right now, so anything that
  // reflows it moves the caret: the textarea growing or scrolling, the window
  // resizing, a phone keyboard shortening the visual viewport, or a webfont
  // arriving after the first paint and re-measuring every glyph.
  useEffect(() => {
    if (!snapshot.open) return;
    const textarea = textareaRef.current;
    const viewport = window.visualViewport;
    const remeasure = () => measure();

    textarea?.addEventListener("scroll", remeasure, { passive: true });
    window.addEventListener("resize", remeasure);
    viewport?.addEventListener("resize", remeasure);
    viewport?.addEventListener("scroll", remeasure);
    // A webfont arriving after the first paint re-measures every glyph, and
    // not every environment has a font loading API to ask.
    document.fonts?.ready?.then(remeasure).catch(() => {});

    return () => {
      textarea?.removeEventListener("scroll", remeasure);
      window.removeEventListener("resize", remeasure);
      viewport?.removeEventListener("resize", remeasure);
      viewport?.removeEventListener("scroll", remeasure);
    };
  }, [measure, snapshot.open, textareaRef]);

  // A menu offering rows from a project nobody is in any more is a menu that
  // cannot be right, and the store's one door for that is closing.
  useEffect(() => {
    if (!projectId) store.controller.close();
  }, [projectId, store]);

  return { menu: store.menu, snapshot, anchor, sync, handleKeyDown };
}

function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (!a || !b) return a === b;
  return a.top === b.top && a.left === b.left && a.height === b.height && a.width === b.width;
}
