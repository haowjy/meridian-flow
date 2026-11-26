import type { Editor } from "@tiptap/core";

import { linkTargetHref } from "@/core/editor/links";
import { FollowOutcomeContent, followOutcomeTitle } from "@/features/links";

import { EditorDialog } from "../../chrome";
import { useEditorScope } from "../../editor-scope";
import { useEditorLinkDestination } from "./ProjectLinkRuntime";
import { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";

export function FollowOutcomeDialog({ editor }: { editor: Editor }) {
  const surface = useLinkSurface(editor);
  const { follow } = useLinkSurfaceState(editor);
  const { projectId, rootThreadId } = useEditorScope();
  const open = useEditorLinkDestination();

  // Mounted only while there is something to say. A dialog that sat closed in
  // every open editor would make every editor depend on the mutation behind its
  // one button.
  if (!surface || !follow) return null;

  return (
    <EditorDialog
      // One dialog per link: following a second link must not open wearing the
      // first one's failed-to-create notice. A checking answer that settles into
      // a missing one keeps the same dialog rather than flashing a new one.
      key={linkTargetHref(follow.target)}
      editor={editor}
      id="link-follow-outcome"
      open
      onOpenChange={(open) => {
        if (!open) surface.dismissFollow();
      }}
      showTitle
      className="sm:max-w-md"
      title={followOutcomeTitle(follow)}
    >
      <FollowOutcomeContent
        outcome={follow}
        projectId={projectId}
        scratchRootThreadId={rootThreadId}
        onClose={() => surface.dismissFollow()}
        onRetry={() => surface.retryFollow()}
        onOpen={(document) => open(document)}
      />
    </EditorDialog>
  );
}
