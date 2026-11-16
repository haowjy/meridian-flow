import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect, useState } from "react";
import { useTrashDiscards } from "@/client/query/useDocumentTrash";
import { Button } from "@/components/ui/button";
import { leftOutSentence, restoreReturnedSentence } from "@/features/draft-review/CommandNotice";
import { useDocumentTrashRestore } from "@/features/project/context/DocumentTrashRestoreProvider";
import { useRestoreDiscard } from "@/features/project/context/use-restore-discard";

/**
 * What the editor's status pill says while the draft or document on screen is in Trash, with
 * Restore: a draft a Discard made elsewhere closed (`draftId`), or a document removed elsewhere.
 * The text stays on screen read-only behind it; a restore reopens it in place.
 */
export function InTrashStatus({
  projectId,
  documentId,
  draftId,
}: {
  projectId: string;
  documentId: string;
  /** The draft on screen, when it is a draft that closed; null for the document itself. */
  draftId: string | null;
}) {
  return draftId ? (
    <DraftInTrash projectId={projectId} documentId={documentId} draftId={draftId} />
  ) : (
    <DocumentInTrash documentId={documentId} />
  );
}

function DraftInTrash({
  projectId,
  documentId,
  draftId,
}: {
  projectId: string;
  documentId: string;
  draftId: string;
}) {
  useLingui();
  const discards = useTrashDiscards(projectId);
  const { states, restore } = useRestoreDiscard(projectId);
  // A list read before the close can't name this draft yet: read it again as the pill appears.
  const [reread, setReread] = useState<string | null>(null);
  const { refetch } = discards;
  useEffect(() => {
    let current = true;
    void refetch().finally(() => current && setReread(draftId));
    return () => {
      current = false;
    };
  }, [refetch, draftId]);
  const entry = discards.data?.entries.find(({ drafts }) =>
    drafts.some((draft) => draft.draftId === draftId),
  );
  const state = entry ? states.get(entry.commandId) : undefined;
  if (!entry)
    return (
      <Pill>
        {reread === draftId && discards.isSuccess ? (
          <Trans>This draft is gone from Trash</Trans>
        ) : (
          <Trans>This draft is in Trash</Trans>
        )}
      </Pill>
    );
  if (state?.kind === "returned") return <Pill>{restoreReturnedSentence(state.why)}</Pill>;
  if (state?.kind === "left_out") return <Pill>{leftOutSentence(state.leftOut)}</Pill>;
  return (
    <Pill
      action={{
        label: state?.kind === "failed" ? t`Try again` : t`Restore`,
        pending: state?.kind === "restoring" || state?.kind === "restored",
        onClick: () =>
          restore({
            commandId: entry.commandId,
            branchId: entry.branchId,
            documentIds: [documentId],
          }),
      }}
    >
      {state?.kind === "failed" ? (
        <Trans>Couldn't restore this draft</Trans>
      ) : (
        <Trans>This draft is in Trash</Trans>
      )}
    </Pill>
  );
}

function DocumentInTrash({ documentId }: { documentId: string }) {
  useLingui();
  const { states, restore } = useDocumentTrashRestore();
  const state = states.get(documentId);
  return (
    <Pill
      action={{
        label: t`Restore`,
        pending: state?.kind === "restored",
        onClick: () => restore([{ ref: { kind: "file", id: documentId }, name: t`this document` }]),
      }}
    >
      <Trans>This document is in Trash</Trans>
    </Pill>
  );
}

function Pill({
  children,
  action,
}: {
  children: ReactNode;
  action?: { label: string; pending: boolean; onClick: () => void };
}) {
  return (
    <div
      className="pointer-events-auto -mr-1.5 inline-flex items-center gap-2 font-medium text-foreground"
      role="status"
      data-in-trash
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
      {action ? (
        <Button
          type="button"
          size="xs"
          variant="secondary"
          disabled={action.pending}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
