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

const NOTICE_LIFETIME_MS = 2600;

export type RunVerb = (work: Promise<unknown>, verb: Verb) => void;

type Verb = "copy" | "download";

const ANSWER = {
  copy: { done: () => t`Copied`, failed: () => t`Couldn't copy` },
  download: { done: () => t`Downloaded`, failed: () => t`Couldn't download` },
} satisfies Record<Verb, { done: () => string; failed: () => string }>;

export function useVerbFeedback(): {
  notice: EditorNotice | null;
  run: RunVerb;
} {
  const [notice, setNotice] = useState<EditorNotice | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = useCallback((work: Promise<unknown>, verb: Verb) => {
    work.then(
      () => setNotice({ tone: "done", message: ANSWER[verb].done() }),
      (error: unknown) => {
        console.warn(`[${verb}] failed`, error);
        setNotice({ tone: "failed", message: ANSWER[verb].failed() });
      },
    );
  }, []);

  return { notice, run };
}

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

const NOTICE_OFFSET_PX = 10;
