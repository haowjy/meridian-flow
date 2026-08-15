/**
 * What a follow says when the document it named is not there.
 *
 * A follow that finds nothing is the interesting case. Serial writers link
 * chapters before they write them, so the honest answer is an offer to write the
 * page now rather than an error: mockup 06 state A, and §5.5's "opening one
 * offers to create the document and link it". Nothing about the link changes when
 * the document appears — `[[Warden Ilsever]]` was always the link, and the
 * resolver simply starts finding it.
 *
 * A chrome surface like any other, and that part is load-bearing: this dialog can
 * arrive a quarter second after the click, by which time the writer may have
 * summoned the slash menu or the link form. Registering as a layer is what makes
 * the kernel replace that surface instead of leaving two of them claiming Escape
 * (law 4). `ProjectLinkRuntime` answers the follow; this only reads the answer.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { validateContextEntryName } from "@meridian/contracts/context-entry-validation";
import type { Editor } from "@tiptap/core";
import { useState } from "react";

import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { Button } from "@/components/ui/button";
import { DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { type LinkFollowOutcome, linkTargetHref } from "@/core/editor/links";
import { useOpenProjectDocument } from "@/features/project/context/open-project-document";

import { EditorDialog } from "../../chrome";
import { useEditorScope } from "../../editor-scope";
import { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";

export function FollowOutcomeDialog({ editor }: { editor: Editor }) {
  const surface = useLinkSurface(editor);
  const { follow } = useLinkSurfaceState(editor);

  // Mounted only while there is something to say. A dialog that sat closed in
  // every open editor would make every editor depend on the mutation behind its
  // one button.
  if (!surface || !follow) return null;

  return (
    <FollowOutcome
      // One dialog per link: following a second link must not open wearing the
      // first one's failed-to-create notice. A checking answer that settles into
      // a missing one keeps the same dialog rather than flashing a new one.
      key={linkTargetHref(follow.target)}
      editor={editor}
      outcome={follow}
      onClose={() => surface.clearFollow()}
      onRetry={() => surface.navigator?.({ target: follow.target, disposition: "current" })}
    />
  );
}

function FollowOutcome({
  editor,
  outcome,
  onClose,
  onRetry,
}: {
  editor: Editor;
  outcome: LinkFollowOutcome;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { projectId, workId } = useEditorScope();
  const createEntry = useCreateContextEntry(projectId ?? "");
  const openDocument = useOpenProjectDocument(projectId ?? undefined);
  const [failedToCreate, setFailedToCreate] = useState(false);

  const { target } = outcome;
  const name = target.kind === "wikilink" ? target.name : null;
  // A wikilink resolves by title, so creating the document means creating a file
  // with exactly that name. A name that cannot be a filename cannot be created
  // from here, and the dialog says so rather than offering a button that would
  // fail.
  const creatable = name !== null && validateContextEntryName(name).ok;

  return (
    <EditorDialog
      editor={editor}
      id="link-follow-outcome"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      showTitle
      className="sm:max-w-md"
      title={
        outcome.state === "checking" ? (
          <Trans>Opening the link</Trans>
        ) : outcome.state === "failed" ? (
          <Trans>That link could not be checked</Trans>
        ) : (
          <Trans>Nothing carries that name yet</Trans>
        )
      }
    >
      <DialogDescription>
        {outcome.state === "checking" ? (
          <Trans>Looking for the document this link names.</Trans>
        ) : outcome.state === "failed" ? (
          <Trans>The project could not be reached. The link itself is fine.</Trans>
        ) : creatable ? (
          <Trans>Create it now and the link starts working. Nothing about the link changes.</Trans>
        ) : (
          <Trans>
            No document answers to this name. A document can be created for it once the name works
            as a filename.
          </Trans>
        )}
      </DialogDescription>

      <p className="rounded-md bg-muted px-3 py-2 font-mono text-ink-muted text-xs">
        {linkTargetHref(target)}
      </p>

      {failedToCreate ? (
        <p className="text-destructive text-xs" role="alert">
          <Trans>The document could not be created. Try again.</Trans>
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {outcome.state === "checking" ? t`Cancel` : t`Close`}
        </Button>
        {outcome.state === "failed" ? (
          <Button type="button" size="sm" onClick={onRetry}>
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
                .mutateAsync({
                  scheme: "manuscript",
                  type: "file",
                  path: `/${name}.md`,
                  workId: null,
                })
                .catch(() => null);
              if (result?.status !== "created" || !result.documentId) {
                setFailedToCreate(true);
                return;
              }
              onClose();
              // Every dashed link to this name in every open document is about
              // to be right, and nothing here has to say so: the project holds a
              // document it did not, which is a new document catalog, and the
              // resolution scope is registered against catalogs.
              await openDocument({ documentId: result.documentId, workId });
            }}
          >
            {createEntry.isPending ? t`Creating…` : t`Create the document`}
          </Button>
        ) : null}
      </DialogFooter>
    </EditorDialog>
  );
}
