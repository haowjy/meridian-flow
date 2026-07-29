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
 * Both scope answers come from the editor's scope: the resolver is asked with the
 * active Work, so a `work://` shorthand has a Work to be relative to, and a
 * document that opens is looked for in that Work's scratch as well as in the
 * manuscript.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import {
  documentLinkTarget,
  getLinkResolution,
  getLinkSurface,
  type InternalLinkNavigator,
  type LinkFollowDisposition,
  type LinkTarget,
  linkTargetHref,
} from "@/core/editor/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";

import { useEditorScope } from "../../editor-scope";
import { useDocumentUri } from "./useDocumentUri";

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
  const { projectId, workId } = useEditorScope();
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const baseUri = useDocumentUri(projectId, documentId);
  const openDocument = useOpenProjectDocument(projectId ?? undefined);

  // Read through a ref: the port is registered once per project and must not be
  // torn down and rebuilt every time the document's URI query settles or the
  // writer's Work arrives.
  const latest = useRef({ baseUri, workId });
  latest.current = { baseUri, workId };

  useEffect(() => {
    if (!resolution || !projectId) return;
    return resolution.registerResolver(async (target) => {
      const { baseUri: base, workId: work } = latest.current;
      const request = documentLinkTarget(target, base ?? "");
      // A relative path is meaningless without the URI of the document holding
      // it. Throwing rather than answering "nothing found" is deliberate: the
      // question could not be asked, and an unasked question must not render as
      // a missing document.
      if (!request) throw new Error("link target is not a document link");
      if (request.kind === "relative" && !base) {
        throw new Error("relative link has no base document URI yet");
      }
      const { document } = await resolveDocumentLink(projectId, {
        workId: work,
        target: request,
      });
      return document;
    });
  }, [resolution, projectId]);

  const follow = useCallback(
    async (target: LinkTarget, disposition: LinkFollowDisposition) => {
      if (!resolution || !surface) return;
      const href = linkTargetHref(target);
      const known = resolution.read(href);
      const open = (documentId: string) =>
        openDocument({
          documentId,
          workId: latest.current.workId,
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
    [openDocument, resolution, surface],
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
