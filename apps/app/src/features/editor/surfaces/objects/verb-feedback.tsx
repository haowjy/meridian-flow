/**
 * What a verb says back.
 *
 * Copy and download reach outside the page — to a clipboard the browser can
 * refuse, to a canvas it can decide is tainted — so every one of them can fail
 * for a reason the writer had no way to predict. Law 5 forbids the silent
 * rejection that follows: a menu item that closes on a `SecurityError` and says
 * nothing has told the writer their diagram was copied.
 *
 * One answer, one place. Every door — a chip on the row, an item in a ⋯, an
 * item in the dialog — routes its promise through `run`, and the surface that
 * owns the verb renders the notice where the writer is already looking: "Copied"
 * or "Couldn't copy". Why it failed goes to the console.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  type EditorNotice,
  EditorNoticePill,
  manuscriptOverlay,
  useAnchorRect,
} from "@/features/editor/chrome";

/** Long enough to read one line while looking at what you just acted on. */
const NOTICE_LIFETIME_MS = 2600;

/** Runs a verb and keeps its answer, success or failure. */
export type RunVerb = (work: Promise<unknown>, verb: Verb) => void;

type Verb = "copy" | "download";

const ANSWER = {
  copy: { done: () => t`Copied`, failed: () => t`Couldn't copy` },
  download: { done: () => t`Downloaded`, failed: () => t`Couldn't download` },
} satisfies Record<Verb, { done: () => string; failed: () => string }>;

export function useVerbFeedback(): {
  notice: EditorNotice | null;
  /** Run a verb and keep its answer. Never rejects; the notice is the answer. */
  run: RunVerb;
} {
  const [notice, setNotice] = useState<EditorNotice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = useCallback((work: Promise<unknown>, verb: Verb) => {
    // Settled rather than awaited: a rejection that escapes here would be an
    // unhandled promise, which is the silent failure this exists to end.
    work.then(
      () => setNotice({ tone: "done", message: ANSWER[verb].done() }),
      (error: unknown) => {
        // The browser's reason (a blocked clipboard, a tainted canvas) is for the log.
        console.warn(`[${verb}] failed`, error);
        setNotice({ tone: "failed", message: ANSWER[verb].failed() });
      },
    );
  }, []);

  return { notice, run };
}

/**
 * The answer, over the object it is about.
 *
 * Above the controls rather than beside them, because the writer's eyes are
 * already at that corner: they just pressed something there. Portalled into the
 * manuscript's pane and measured in its coordinates, like the controls
 * themselves, so nothing it says can move a line of the manuscript and nothing
 * it says can be read outside the editor.
 */
export function ObjectVerbNotice({
  editor,
  anchor,
  notice,
}: {
  editor: Editor;
  anchor: HTMLElement | null;
  notice: EditorNotice | null;
}) {
  const rect = useAnchorRect(editor, anchor);
  const overlay = manuscriptOverlay(editor);
  if (!notice || !rect || !overlay || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="meridian-verb-notice"
      style={{ top: rect.top + NOTICE_OFFSET_PX, left: rect.right - NOTICE_OFFSET_PX }}
    >
      <EditorNoticePill notice={notice} />
    </div>,
    overlay,
  );
}

/** Matches the controls' inset, so the two read as one stack in the corner. */
const NOTICE_OFFSET_PX = 10;
