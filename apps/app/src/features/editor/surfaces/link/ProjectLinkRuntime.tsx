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
 * **An answer belongs to a scope, not to a href.** What `[[Notes]]` or
 * `./cast.md` points at is a function of the project, the active Work, and the
 * URI of the document holding the link; the same three are this component's own
 * inputs. So the resolver is registered per scope and re-registered when the
 * scope changes, and `registerResolver` drops every answer and every failure the
 * previous scope produced before the next question is asked. That keeps Work a
 * runtime scope — nothing here remounts the collaborative editor — while making
 * a stale answer unreachable rather than merely unlikely.
 */

import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo } from "react";

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
import { useWikilinkDocuments } from "./useWikilinkDocuments";

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
  const documents = useWikilinkDocuments(scope);
  const openDocument = useOpenProjectDocument(projectId ?? undefined);

  // What this document's relative links are relative to, read out of the same
  // index the `[[` menu offers rows from: a scratch note the menu names is a
  // note that can hold `./cast.md` too. Null until the tree carrying it
  // arrives, which is a link with no answer yet rather than a missing document.
  const baseUri = useMemo(
    () => documents.find((document) => document.documentId === documentId)?.uri ?? null,
    [documents, documentId],
  );

  useEffect(() => {
    if (!resolution || !projectId) return;
    return resolution.registerResolver(async (target) => {
      const request = documentLinkTarget(target, baseUri ?? "");
      // A relative path is meaningless without the URI of the document holding
      // it. Throwing rather than answering "nothing found" is deliberate: the
      // question could not be asked, and an unasked question must not render as
      // a missing document. The base arriving is a scope change, so this same
      // link is asked again instead of staying failed.
      if (!request) throw new Error("link target is not a document link");
      if (request.kind === "relative" && !baseUri) {
        throw new Error("relative link has no base document URI yet");
      }
      const { document } = await resolveDocumentLink(projectId, {
        workId,
        target: request,
      });
      return document;
    });
  }, [baseUri, projectId, resolution, workId]);

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
