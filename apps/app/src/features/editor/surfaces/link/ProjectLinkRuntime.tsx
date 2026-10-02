/**
 * The Editor's adapter over the app's link follower: where an internal link in
 * this editor actually goes.
 *
 * The editor core knows a link is internal and nothing else; the project, the
 * Work, the router, and the tab strip are the app's, and resolving and
 * following belong to [`features/links`](../../../links/AGENTS.md). This
 * supplies the Editor's three parts (its scope, its destination, and the store
 * its outcome is reported into), registers the follower as the navigator a
 * click is handed to and as the store's follow handlers, and renders nothing.
 * Registering the navigator is also what makes the link menu's Open link verb
 * appear at all: absent until something can follow, never dead (law 5).
 *
 * What a follow FOUND is reported into the link store, and the surface that
 * says it out loud mounts through the chrome host
 * ([`FollowOutcomeDialog`](FollowOutcomeDialog.tsx)). A dialog opened from here
 * would be a transient surface the kernel never heard about — and this one can
 * open a quarter second late, long after the writer summoned something else.
 *
 * A Work switch, a base URI arriving, and a rename are all scope changes the
 * follower re-registers on, so nothing here remounts the collaborative editor.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo } from "react";

import { getLinkResolution, getLinkSurface, type InternalLinkNavigator } from "@/core/editor/links";
import {
  type FollowReporter,
  type LinkableDocumentIndex,
  type LinkDestination,
  type LinkResolutionScope,
  useLinkFollower,
} from "@/features/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";

import { useEditorScope } from "../../editor-scope";

/**
 * The Editor's destination: the document opens in this editor's pane, or on
 * the tab strip for a new-tab gesture, in the editor's own Work.
 */
export function useEditorLinkDestination(): LinkDestination {
  const { projectId, workId } = useEditorScope();
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  return useCallback(
    (document, gesture) =>
      openDocument({
        documentId: document.documentId,
        workId,
        disposition: gesture === "new-tab" ? "background" : "current",
      }),
    [openDocument, workId],
  );
}

/** Runtime over the scope's document index, which the Editor also reads its holder from. */
export function ProjectLinkRuntime({
  editor,
  baseUri,
  index,
  active,
}: {
  editor: Editor | null;
  /**
   * The document's own address: what its relative links are relative to.
   * Null until the tree carrying it arrives, which is a link with no answer
   * yet rather than a missing document.
   */
  baseUri: string | null;
  index: LinkableDocumentIndex;
  active: boolean;
}) {
  const { projectId, workId } = useEditorScope();
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const open = useEditorLinkDestination();

  const scope = useMemo<LinkResolutionScope | null>(
    () => (active && projectId ? { projectId, workId, baseUri } : null),
    [active, baseUri, projectId, workId],
  );
  const reporter = useMemo<FollowReporter>(
    () => ({
      report: (outcome) => surface?.reportFollow(outcome),
      clear: () => surface?.clearFollow(),
    }),
    [surface],
  );
  // Inactive is scope null: the follower aborts and dismisses on its own.
  const follower = useLinkFollower({ scope, index, resolution, open, reporter });

  useEffect(() => {
    if (!active || !surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, disposition }) => {
      follower.follow(target, disposition);
    };
    const unregisterNavigator = surface.registerNavigator(navigate);
    // What the outcome dialog's Close, Cancel, and Try again mean is the
    // follower's: it knows which follow owns what is shown.
    const unregisterHandlers = surface.registerFollowHandlers({
      dismiss: follower.dismiss,
      retry: follower.retry,
    });
    return () => {
      unregisterNavigator();
      unregisterHandlers();
    };
  }, [active, follower, projectId, surface]);

  return null;
}
