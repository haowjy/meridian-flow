/**
 * What a verb says back.
 *
 * Copy and download reach outside the page — to a clipboard the browser can
 * refuse, to a canvas it can decide is tainted — so every one of them can fail
 * for a reason the writer had no way to predict. Law 5 forbids the silent
 * rejection that follows: a menu item that closes on a `SecurityError` and says
 * nothing has told the writer their diagram was copied.
 *
 * One answer, one place. Every door — a chip on the row, an item in a ⋮, an
 * item in the dialog — routes its promise through `run`, and the surface that
 * owns the verb renders the notice where the writer is already looking. The
 * failure keeps its reason: "the browser blocked the clipboard" and "this
 * browser cannot export this diagram" call for different next moves.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useAnchorRect } from "@/features/editor/chrome";
import { cn } from "@/lib/utils";

import { ExportError } from "./object-commands";

/** Long enough to read one line while looking at what you just acted on. */
const NOTICE_LIFETIME_MS = 2600;

export type VerbNotice = { tone: "done" | "failed"; message: string };

/**
 * Why a verb failed, in the writer's terms.
 *
 * Named cases rather than the raw message: `NotAllowedError` and
 * `SecurityError` are the two the browser actually produces here, they mean
 * completely different things, and neither reads as English.
 */
export function verbFailureMessage(error: unknown): string {
  if (error instanceof ExportError) {
    return error.kind === "unreadable"
      ? t`That image could not be read.`
      : t`This browser will not turn that into an image.`;
  }

  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") {
    return t`The browser blocked the clipboard. Check this site's permissions.`;
  }
  if (name === "SecurityError") {
    // A canvas drawn from an SVG that reaches outside the page is tainted, and
    // the export is refused at the last step. Mermaid source always copies, so
    // the writer is pointed at the door that works.
    return t`This browser will not export this diagram as an image. Copy the Mermaid source instead.`;
  }
  return t`That did not work.`;
}

export function useVerbFeedback(): {
  notice: VerbNotice | null;
  /** Run a verb and keep its answer. Never rejects; the notice is the answer. */
  run: (work: Promise<unknown>, done: string) => void;
} {
  const [notice, setNotice] = useState<VerbNotice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = useCallback((work: Promise<unknown>, done: string) => {
    // Settled rather than awaited: a rejection that escapes here would be an
    // unhandled promise, which is the silent failure this exists to end.
    work.then(
      () => setNotice({ tone: "done", message: done }),
      (error: unknown) => setNotice({ tone: "failed", message: verbFailureMessage(error) }),
    );
  }, []);

  return { notice, run };
}

/**
 * The notice itself: a pill in the same language as the editor's other
 * transient statuses (`PassageNotice`). It blocks nothing and never moves the
 * manuscript.
 */
export function VerbNoticePill({
  notice,
  className,
}: {
  notice: VerbNotice | null;
  className?: string;
}) {
  if (!notice) return null;

  return (
    <p
      role="status"
      data-verb-notice={notice.tone}
      className={cn(
        "pointer-events-none animate-in whitespace-nowrap rounded-full border px-3 py-1 text-caption shadow-card fade-in-0",
        notice.tone === "failed"
          ? "border-destructive-border bg-destructive-tint text-destructive"
          : "border-border bg-card text-ink-muted",
        className,
      )}
    >
      {notice.message}
    </p>
  );
}

/**
 * The answer, over the object it is about.
 *
 * Above the controls rather than beside them, because the writer's eyes are
 * already at that corner: they just pressed something there. Portalled and
 * fixed like the controls themselves, so nothing it says can move a line of
 * the manuscript.
 */
export function ObjectVerbNotice({
  editor,
  anchor,
  notice,
}: {
  editor: Editor;
  anchor: HTMLElement | null;
  notice: VerbNotice | null;
}) {
  const rect = useAnchorRect(editor, anchor);
  if (!notice || !rect || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="meridian-verb-notice"
      style={{ top: rect.top + NOTICE_OFFSET_PX, left: rect.right - NOTICE_OFFSET_PX }}
    >
      <VerbNoticePill notice={notice} />
    </div>,
    document.body,
  );
}

/** Matches the controls' inset, so the two read as one stack in the corner. */
const NOTICE_OFFSET_PX = 10;
