import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useDocumentTrashRestore } from "@/features/project/context/DocumentTrashRestoreProvider";

/**
 * What the editor's status pill says while the document on screen is in Trash, with Restore: a
 * document removed elsewhere. The text stays on screen read-only behind it; a restore reopens it
 * in place.
 */
export function InTrashStatus({ documentId }: { documentId: string }) {
  return <DocumentInTrash documentId={documentId} />;
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
