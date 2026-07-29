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
 */

import { Trans } from "@lingui/react/macro";
import type { Editor } from "@tiptap/core";
import { UploadCloud } from "lucide-react";
import { useSyncExternalStore } from "react";

import {
  type ImageIngressStatus,
  imageIngressStatus as ingressStatusStore,
} from "@/core/editor/images";
import { VerbNoticePill } from "@/features/editor/surfaces/objects";

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

export function ImageIngressOverlay({
  editor,
  editable,
}: {
  editor: Editor | null;
  editable: boolean;
}) {
  const status = useImageIngressStatus(editor);

  return (
    <>
      {editable && status.dropActive ? (
        <div className="meridian-editor-drop-overlay" aria-hidden>
          <UploadCloud className="size-8" />
          <span>
            <Trans>Drop image to insert it</Trans>
          </span>
        </div>
      ) : null}
      {status.notice ? (
        <div className="meridian-image-refusal">
          <VerbNoticePill notice={{ tone: "failed", message: status.notice.message }} />
        </div>
      ) : null}
    </>
  );
}

function noSubscription(): () => void {
  return () => {};
}

function idleStatus(): ImageIngressStatus {
  return IDLE;
}
