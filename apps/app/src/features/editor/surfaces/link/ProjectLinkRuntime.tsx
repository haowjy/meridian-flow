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
 * A holder location change, a base URI arriving, a rename, and a change to the document's
 * own text are all scope changes the follower re-registers on, so nothing here remounts the collaborative editor.
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
import { useDocumentRevision } from "./useDocumentRevision";

/**
 * The Editor's destination: the document opens in this editor's pane, or on
 * the tab strip for a new-tab gesture, using the holder's link scope.
 */
export function useEditorLinkDestination(): LinkDestination {
  const { projectId, workId } = useEditorScope();
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  return useCallback(
    (document, gesture) =>
      openDocument({
        documentId: document.documentId,
        workId: workId ?? undefined,
        disposition: gesture === "new-tab" ? "background" : "current",
      }),
    [openDocument, workId],
  );
}

/** Runtime over the scope's document index, which the Editor also reads its holder from. */
export function ProjectLinkRuntime({
  editor,
  documentId,
  baseUri,
  index,
  active,
}: {
  editor: Editor | null;
  /** The document holding the links: the scope is one document's text. */
  documentId: string;
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

  const documentRevision = useDocumentRevision(editor);

  // The holder's Work arrives with its resource record. Until then the scope is
  // pending, so a click waits for the real scope instead of being dropped.
  const scope = useMemo<LinkResolutionScope | "pending" | null>(
    () =>
      !active || !projectId
        ? null
        : workId
          ? { projectId, workId, baseUri, holderDocumentId: documentId, documentRevision }
          : "pending",
    [active, baseUri, documentId, documentRevision, projectId, workId],
  );
  const reporter = useMemo<FollowReporter>(
    () => ({
      report: (outcome) => surface?.reportFollow(outcome),
      clear: () => surface?.clearFollow(),
    }),
    [surface],
  );
  // Inactive or project-less is scope null: the follower aborts and dismisses on its own.
  const follower = useLinkFollower({ scope, index, resolution, open, reporter });

  useEffect(() => {
    if (!active || !surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, ref, disposition }) => {
      follower.follow(target, disposition, ref);
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
