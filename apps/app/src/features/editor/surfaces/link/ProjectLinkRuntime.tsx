/**
 * Where an internal link actually goes, and what it says when it goes nowhere.
 *
 * The editor core knows a link is internal and nothing else; the project, the
 * work, the router, and the tab strip are the app's. This component is that
 * seam: it registers the resolution port the manuscript's links are drawn
 * from, and the navigator that a click hands its target to. Registering the
 * navigator is also what makes the link menu's Open link verb appear at all —
 * absent until something can follow, never dead (law 5).
 *
 * A follow that finds nothing is the interesting case. Serial writers link
 * chapters before they write them, so the honest answer is an offer to write
 * the page now rather than an error: mockup 06 state A, and §5.5's "opening
 * one offers to create the document and link it". Nothing about the link
 * changes when the document appears — `[[Warden Ilsever]]` was always the
 * link, and the resolver simply starts finding it.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveDocumentLink } from "@/client/api/document-links-api";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

import { useDocumentUri } from "./useDocumentUri";

/**
 * How long a follow waits before admitting it is still asking. Under this, the
 * answer is usually already cached from rendering the link and the writer sees
 * the document open; over it, a silent click would read as a dead control.
 */
const CHECKING_DELAY_MS = 250;

/** What a follow found, once it is worth interrupting the writer about. */
type FollowOutcome =
  | { state: "checking"; target: LinkTarget }
  | { state: "missing"; target: LinkTarget }
  | { state: "failed"; target: LinkTarget };

export function ProjectLinkRuntime({
  editor,
  projectId,
  documentId,
}: {
  editor: Editor | null;
  projectId: string | undefined;
  documentId: string;
}) {
  const resolution = useMemo(() => getLinkResolution(editor), [editor]);
  const surface = useMemo(() => getLinkSurface(editor), [editor]);
  const baseUri = useDocumentUri(projectId, documentId);
  const openDocument = useOpenProjectDocument(projectId);
  const [outcome, setOutcome] = useState<FollowOutcome | null>(null);

  // Read through a ref: the port is registered once per project and must not
  // be torn down and rebuilt every time the document's URI query settles.
  const baseUriRef = useRef(baseUri);
  baseUriRef.current = baseUri;

  useEffect(() => {
    if (!resolution || !projectId) return;
    return resolution.registerResolver(async (target) => {
      const request = documentLinkTarget(target, baseUriRef.current ?? "");
      // A relative path is meaningless without the URI of the document holding
      // it. Throwing rather than answering "nothing found" is deliberate: the
      // question could not be asked, and an unasked question must not render
      // as a missing document.
      if (!request) throw new Error("link target is not a document link");
      if (request.kind === "relative" && !baseUriRef.current) {
        throw new Error("relative link has no base document URI yet");
      }
      const { document } = await resolveDocumentLink(projectId, { target: request });
      return document;
    });
  }, [resolution, projectId]);

  const follow = useCallback(
    async (target: LinkTarget, disposition: LinkFollowDisposition) => {
      if (!resolution) return;
      const href = linkTargetHref(target);
      const known = resolution.read(href);
      const open = (documentId: string) =>
        openDocument({
          documentId,
          disposition: disposition === "new-tab" ? "background" : "current",
        });

      // The common case: the link was resolved to draw it, so following is
      // instant and nothing is ever shown.
      if (known?.state === "resolved") {
        setOutcome(null);
        await open(known.document.documentId);
        return;
      }

      let settled = false;
      const checking = window.setTimeout(() => {
        if (!settled) setOutcome({ state: "checking", target });
      }, CHECKING_DELAY_MS);

      const entry = await resolution.resolve(href);
      settled = true;
      window.clearTimeout(checking);

      if (entry?.state === "resolved") {
        setOutcome(null);
        await open(entry.document.documentId);
        return;
      }
      setOutcome({ state: entry?.state === "unresolved" ? "missing" : "failed", target });
    },
    [openDocument, resolution],
  );

  useEffect(() => {
    if (!surface || !projectId) return;
    const navigate: InternalLinkNavigator = ({ target, disposition }) => {
      void follow(target, disposition);
    };
    return surface.registerNavigator(navigate);
  }, [follow, projectId, surface]);

  // Mounted only while there is something to say. A dialog that sat closed in
  // every open editor would make every editor depend on the mutation behind
  // its one button.
  if (!outcome) return null;

  return (
    <FollowOutcomeDialog
      outcome={outcome}
      projectId={projectId}
      onClose={() => setOutcome(null)}
      onCreated={async (createdDocumentId) => {
        setOutcome(null);
        // Every dashed link to this name in every open document is about to be
        // wrong; the answers they were drawn from are the ones to drop.
        resolution?.refresh();
        await openDocument({ documentId: createdDocumentId });
      }}
      onRetry={(target) => void follow(target, "current")}
    />
  );
}

function FollowOutcomeDialog({
  outcome,
  projectId,
  onClose,
  onCreated,
  onRetry,
}: {
  outcome: FollowOutcome;
  projectId: string | undefined;
  onClose: () => void;
  onCreated: (documentId: string) => void;
  onRetry: (target: LinkTarget) => void;
}) {
  const createEntry = useCreateContextEntry(projectId ?? "");
  const [failedToCreate, setFailedToCreate] = useState(false);

  const { target } = outcome;
  const name = target.kind === "wikilink" ? target.name : null;
  // A wikilink resolves by title, so creating the document means creating a
  // file with exactly that name. A name that cannot be a filename cannot be
  // created from here, and the dialog says so rather than offering a button
  // that would fail.
  const creatable = name !== null && validateContextEntryName(name).ok;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        setFailedToCreate(false);
        onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {outcome.state === "checking" ? (
              <Trans>Opening the link</Trans>
            ) : outcome.state === "failed" ? (
              <Trans>That link could not be checked</Trans>
            ) : (
              <Trans>Nothing carries that name yet</Trans>
            )}
          </DialogTitle>
          <DialogDescription>
            {outcome.state === "checking" ? (
              <Trans>Looking for the document this link names.</Trans>
            ) : outcome.state === "failed" ? (
              <Trans>The project could not be reached. The link itself is fine.</Trans>
            ) : creatable ? (
              <Trans>
                Create it now and the link starts working. Nothing about the link changes.
              </Trans>
            ) : (
              <Trans>
                No document answers to this name. A document can be created for it once the name
                works as a filename.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <p className="rounded-md bg-muted px-3 py-2 font-mono text-ink-muted text-xs">
          {linkTargetHref(target)}
        </p>

        {failedToCreate ? (
          <p className="text-destructive text-xs" role="alert">
            <Trans>The document could not be created. Try again.</Trans>
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="ghost" size="sm">
              {outcome.state === "checking" ? t`Cancel` : t`Close`}
            </Button>
          </DialogClose>
          {outcome.state === "failed" ? (
            <Button type="button" size="sm" onClick={() => onRetry(target)}>
              {t`Try again`}
            </Button>
          ) : null}
          {outcome.state === "missing" && creatable && name ? (
            <Button
              type="button"
              size="sm"
              disabled={createEntry.isPending}
              onClick={async () => {
                setFailedToCreate(false);
                const result = await createEntry
                  .mutateAsync({ scheme: "manuscript", type: "file", path: `/${name}.md` })
                  .catch(() => null);
                if (result?.status === "created" && result.documentId) {
                  onCreated(result.documentId);
                  return;
                }
                setFailedToCreate(true);
              }}
            >
              {createEntry.isPending ? t`Creating…` : t`Create the document`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
