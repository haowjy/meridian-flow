/**
 * The Editor's host for what a follow says: the shared outcome presenter inside
 * an `EditorDialog`.
 *
 * A chrome surface like any other, and that part is load-bearing: this dialog
 * can arrive a quarter second after the click, by which time the writer may
 * have summoned the slash menu or the link form. Registering as a layer is what
 * makes the kernel replace that surface instead of leaving two of them claiming
 * Escape (law 4). `ProjectLinkRuntime` answers the follow; this only reads the
 * answer.
 */

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
        onOpen={(document) => open(document, "current")}
      />
    </EditorDialog>
  );
}
