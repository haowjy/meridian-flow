/**
 * The app's half of the link system: where an internal link actually goes.
 *
 * The editor core knows a link is internal and nothing else; the project, the
 * Work, the router, and the tab strip are the app's. This is that seam and only
 * that seam — it registers the resolution port the manuscript's links are drawn
 * from and the navigator a follow is handed to, and it renders nothing.
 * Registering the navigator is also what makes the link menu's Open link verb
 * appear at all: absent until something can follow, never dead (law 5).
 *
 * What a follow FOUND is reported into the link store, and the surface that says
 * it out loud mounts through the chrome host
 * ([`FollowOutcomeDialog`](FollowOutcomeDialog.tsx)). A dialog opened from here
 * would be a transient surface the kernel never heard about — and this one can
 * open a quarter second late, long after the writer summoned something else.
 *
 * **An answer belongs to a scope, not to a href**, and the scope's port is
 * [`useProjectLinkResolver`](../../../project/context/project-link-resolver.ts),
 * shared with the chat transcript. What this component adds is the editor half:
 * registering that port against THIS editor's store, keyed on the document
 * holding the links, and turning a follow into an open tab. Re-registering is
 * the whole invalidation mechanism, so a rename needs no line that pokes a
 * cache and Work stays a runtime scope — nothing here remounts the
 * collaborative editor.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo } from "react";

import {
  getLinkResolution,
  getLinkSurface,
  type InternalLinkNavigator,
  type LinkFollowDisposition,
} from "@/core/editor/links";
import { type LinkTarget, linkTargetHref } from "@/core/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";
import { useProjectLinkResolver } from "@/features/project/context/project-link-resolver";

import { useEditorScope } from "../../editor-scope";

/**
 * How long a follow waits before admitting it is still asking. Under this, the
 * answer is usually already cached from rendering the link and the writer sees
 * the document open; over it, a silent click would read as a dead control.
 */
const CHECKING_DELAY_MS = 250;

export function ProjectLinkRuntime({
  editor,
  documentId,
}: {
  editor: Editor | null;
  documentId: string;
}) {
  const scope = useEditorScope();
  const { projectId, workId } = scope;
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const { resolve, revision } = useProjectLinkResolver(scope, documentId);
  const openDocument = useOpenProjectDocument(projectId ?? undefined);

  useEffect(() => {
    if (!resolution || !resolve) return;
    return resolution.registerResolver(resolve);
    // `revision` is in here without being read: registering against a different
    // catalog is how an answer about the old one becomes unreachable.
  }, [resolution, resolve, revision]);

  const follow = useCallback(
    async (target: LinkTarget, disposition: LinkFollowDisposition) => {
      if (!resolution || !surface) return;
      const href = linkTargetHref(target);
      const known = resolution.read(href);
      const open = (documentId: string) =>
        openDocument({
          documentId,
          workId,
          disposition: disposition === "new-tab" ? "background" : "current",
        });

      // The common case: the link was resolved to draw it, so following is
      // instant and nothing is ever shown.
      if (known?.state === "resolved") {
        surface.clearFollow();
        await open(known.document.documentId);
        return;
      }

      let settled = false;
      const checking = window.setTimeout(() => {
        if (!settled) surface.reportFollow({ state: "checking", target });
      }, CHECKING_DELAY_MS);

      const entry = await resolution.resolve(href);
      settled = true;
      window.clearTimeout(checking);

      if (entry?.state === "resolved") {
        surface.clearFollow();
        await open(entry.document.documentId);
        return;
      }
      surface.reportFollow({
        state: entry?.state === "unresolved" ? "missing" : "failed",
        target,
      });
    },
    [openDocument, resolution, surface, workId],
  );

  useEffect(() => {
    if (!surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, disposition }) => {
      void follow(target, disposition);
    };
    return surface.registerNavigator(navigate);
  }, [follow, projectId, surface]);

  return null;
}
