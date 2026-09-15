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
 * `./cast.md` points at is a function of the project, the active Work, the URI
 * of the document holding the link, and which documents the project holds; all
 * four are this component's own inputs, the last as the document index's
 * revision. So the resolver is registered per scope and re-registered when any
 * of them changes, and `registerResolver` drops every answer and every failure
 * the previous scope produced before the next question is asked. That keeps Work
 * a runtime scope — nothing here remounts the collaborative editor — while
 * making a stale answer unreachable rather than merely unlikely.
 *
 * A rename is the case that makes the catalog part load-bearing: `[[Old Name]]`
 * is spelled the same before and after, and the answer it already has is now a
 * door onto the wrong document. One lifecycle owns all four, so no mutation
 * anywhere in the app needs a line that pokes this cache.
 */

import { documentTitleFromUri, parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentLinkTarget, ResolvedDocumentLink } from "@meridian/contracts/protocol";
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
import {
  type LinkableDocument,
  type LinkableDocumentIndex,
  useLinkableDocuments,
} from "./useLinkableDocuments";

/**
 * How long a follow waits before admitting it is still asking. Under this, the
 * answer is usually already cached from rendering the link and the writer sees
 * the document open; over it, a silent click would read as a dead control.
 */
const CHECKING_DELAY_MS = 250;

/** Resolve against the same projected catalog that offers link candidates. */
export function resolveProjectedDocumentLink(
  documents: readonly LinkableDocument[],
  target: DocumentLinkTarget,
): ResolvedDocumentLink | null | undefined {
  let matches: readonly LinkableDocument[];
  if (target.kind === "wikilink") {
    const name = target.name.trim().toLowerCase();
    matches = documents.filter((document) =>
      [document.filename, document.title, ...(document.aliases ?? [])].some(
        (candidate) => candidate.trim().toLowerCase() === name,
      ),
    );
  } else {
    const base = parseContextUri(target.kind === "scheme" ? target.uri : target.baseUri);
    if (!base.ok || !base.value.path) return undefined;
    const requestedPath =
      target.kind === "relative"
        ? relativeDocumentPath(base.value.path, target.path)
        : base.value.path;
    if (!requestedPath) return undefined;
    matches = documents.filter((document) => {
      const candidate = parseContextUri(document.uri);
      if (!candidate.ok || candidate.value.scheme !== base.value.scheme) return false;
      if (!sameDocumentPath(candidate.value.path, requestedPath)) return false;
      if (base.value.authority.kind === "contextual") return true;
      return JSON.stringify(candidate.value.authority) === JSON.stringify(base.value.authority);
    });
  }
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) return null;
  const document = matches[0];
  if (!document) return null;
  const parsed = parseContextUri(document.uri);
  if (!parsed.ok) return null;
  return {
    documentId: document.documentId,
    title: documentTitleFromUri(document.uri) ?? document.title,
    scheme: parsed.value.scheme,
    path: parsed.value.path,
    uri: document.uri,
    workId: document.workId,
  };
}

function sameDocumentPath(candidate: string, requested: string): boolean {
  return (
    candidate === requested ||
    (candidate.lastIndexOf(".") > candidate.lastIndexOf("/") &&
      candidate.slice(0, candidate.lastIndexOf(".")) === requested)
  );
}

function relativeDocumentPath(base: string, relative: string): string | null {
  if (!relative || relative.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(relative)) return null;
  const segments = base.split("/");
  segments.pop();
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.length > 0 ? segments.join("/") : null;
}

export function ProjectLinkRuntime({
  editor,
  documentId,
}: {
  editor: Editor | null;
  documentId: string;
}) {
  const scope = useEditorScope();
  const index = useLinkableDocuments(scope);
  return (
    <ProjectLinkRuntimeWithIndex editor={editor} documentId={documentId} index={index} active />
  );
}

/** Runtime over the index already consumed by the editor's wikilink completion surface. */
export function ProjectLinkRuntimeWithIndex({
  editor,
  documentId,
  index,
  active,
}: {
  editor: Editor | null;
  documentId: string;
  index: LinkableDocumentIndex;
  active: boolean;
}) {
  const scope = useEditorScope();
  const { projectId, workId } = scope;
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const { documents, revision, complete } = index;
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
    if (!active || !resolution || !projectId) return;
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
      const local = complete ? resolveProjectedDocumentLink(documents, request) : undefined;
      if (local !== undefined) return local;
      const { document } = await resolveDocumentLink(projectId, {
        workId,
        target: request,
      });
      return document;
    });
    // `revision` is in here without being read: registering against a different
    // catalog is how an answer about the old one becomes unreachable.
  }, [active, baseUri, complete, documents, projectId, resolution, revision, workId]);

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
    if (!active || !surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, disposition }) => {
      void follow(target, disposition);
    };
    return surface.registerNavigator(navigate);
  }, [active, follow, projectId, surface]);

  return null;
}
