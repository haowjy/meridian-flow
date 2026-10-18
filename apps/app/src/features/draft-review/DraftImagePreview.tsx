/**
 * DraftImagePreview — opens a picture that exists only in a Work's branch.
 *
 * A draft-only image has no review room (there is no text to diff) and no
 * live path to read, so the strip and the Work page open it here, in a plain
 * preview signed through the Work that holds it.
 */
import { t } from "@lingui/core/macro";
import { classifyFiletype, filetypeForPath } from "@meridian/contracts/protocol";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAssetImageRenderState } from "@/core/editor/asset-image-render-state";

/** Whether a draft's address names a picture, which is what this preview can show. */
export function isDraftImagePath(path: string | null | undefined): boolean {
  if (!path) return false;
  const classification = classifyFiletype(filetypeForPath(path));
  return classification.kind === "binary" && classification.fileType === "image";
}

export type DraftImagePreviewTarget = {
  projectId: string;
  workId: string;
  documentId: string;
  name: string;
};

export function DraftImagePreview({
  target,
  onClose,
}: {
  target: DraftImagePreviewTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[min(90vw,48rem)]">
        {target ? <PreviewBody target={target} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ target }: { target: DraftImagePreviewTarget }) {
  const [state, actions] = useAssetImageRenderState({
    projectId: target.projectId,
    workId: target.workId,
    src: `asset:${target.documentId}`,
  });
  return (
    <>
      <DialogTitle className="truncate">{target.name}</DialogTitle>
      <DialogDescription>{t`Waiting for your review`}</DialogDescription>
      <div className="grid min-h-32 place-items-center">
        {state.url ? (
          <img
            src={state.url}
            alt={target.name}
            onError={actions.imageLoadFailed}
            onLoad={actions.imageDisplayed}
            className="max-h-[60svh] max-w-full rounded-md border border-border object-contain"
          />
        ) : (
          <p className="text-meta text-ink-subtle">
            {"message" in state && state.message ? state.message : t`Loading`}
          </p>
        )}
      </div>
    </>
  );
}
