import { Trans } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { UploadCloud } from "lucide-react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  type ImageIngressStatus,
  imageIngressStatus as ingressStatusStore,
} from "@/core/editor/images";
import { EditorNoticePill } from "@/features/editor/chrome";

import "./image-ingress.css";

const IDLE: ImageIngressStatus = { dropActive: false, notice: null };

export function useImageIngressStatus(editor: Editor | null): ImageIngressStatus {
  const store = ingressStatusStore(editor);
  return useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSnapshot ?? idleStatus,
    idleStatus,
  );
}

export function ImageIngressOverlay({ editor }: { editor: Editor }) {
  const status = useImageIngressStatus(editor);
  const showDropHint = status.dropActive && editor.isEditable;
  const pane = showDropHint || status.notice ? editorPane(editor) : null;
  if (!pane) return null;

  return createPortal(
    <>
      {showDropHint ? (
        <div className="meridian-editor-drop-overlay" aria-hidden>
          <UploadCloud className="size-8" />
          <span>
            <Trans>Drop to insert</Trans>
          </span>
        </div>
      ) : null}
      {status.notice ? (
        <div className="meridian-image-refusal">
          <EditorNoticePill notice={{ tone: "failed", message: status.notice.message }} />
        </div>
      ) : null}
    </>,
    pane,
  );
}

function editorPane(editor: Editor): HTMLElement | null {
  if (editor.isDestroyed) return null;
  return editor.view.dom.closest<HTMLElement>("[data-stable-layout-scroll]");
}

function noSubscription(): () => void {
  return () => {};
}

function idleStatus(): ImageIngressStatus {
  return IDLE;
}
