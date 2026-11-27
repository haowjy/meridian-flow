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

  if (!surface || !follow) return null;

  return (
    <EditorDialog
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
