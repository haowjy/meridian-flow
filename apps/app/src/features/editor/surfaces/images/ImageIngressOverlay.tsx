/**
 * What image ingress shows that is not a picture in the document.
 *
 * Two things only, and both are about events rather than content: a drag in the
 * air, and a refusal. Everything else a picture does while it arrives happens
 * in its own node, in its own slot, where the writer is looking.
 *
 * There is deliberately no upload status here. A progress report beside the
 * manuscript was the old shape, and it could only ever describe one upload
 * while promising the writer nothing about where the picture would land.
 *
 * A chrome surface like every other one: it arrives through
 * `EDITOR_CHROME_SURFACES` with the editor and nothing else, and reads the drag
 * state and the writer's editability off it. It is portalled INTO the scroll
 * pane rather than rendered beside it, because both things it draws are measured
 * against the manuscript's own box: a dashed drop zone inset from the pane, and
 * a pill at the top of the pane. Mounted at the shell instead, each would reach
 * over the toolbar.
 */

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

/** Drag state and the current refusal, for the host and the overlay alike. */
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
            <Trans>Drop image to insert it</Trans>
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

/**
 * The scroll pane the manuscript lives in, which is the box both of these are
 * measured against. `EditorSurfaceFrame` marks it for the layout watcher, so
 * asking the prose for its own scroller needs no prop from the shell.
 */
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
