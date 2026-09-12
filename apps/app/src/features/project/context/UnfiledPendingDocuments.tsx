/** Reopen device-local writing independently of whether its original tab is still open. */
import { t } from "@lingui/core/macro";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useContextTabsActions } from "@/client/stores";
import { Button } from "@/components/ui/button";
import {
  useCaptureProjectNavigation,
  useOpenContextRoute,
} from "../routing/ProjectNavigationContext";
import { useLocalUntitledOwner } from "./account-feature-context";
import type { LocalUntitledWorkSnapshot } from "./local-untitled-owner";
import { useOpenProjectDocument } from "./open-project-document";

export function UnfiledPendingDocuments({
  projectId,
  editorWorkId,
  documents,
}: {
  projectId: string;
  editorWorkId: string | null;
  documents: readonly LocalUntitledWorkSnapshot[];
}) {
  const owner = useLocalUntitledOwner();
  const { openTab, selectTab } = useContextTabsActions();
  const capture = useCaptureProjectNavigation();
  const openRoute = useOpenContextRoute();
  const openDocument = useOpenProjectDocument(projectId);
  const [error, setError] = useState<string | null>(null);
  async function reopen(record: LocalUntitledWorkSnapshot) {
    const isCurrent = capture?.();
    setError(null);
    try {
      const restored = await owner.restore(record.key);
      if (isCurrent?.() === false) return;
      if (restored.kind !== "opened") {
        setError(t`This document is open in another browser tab.`);
        return;
      }
      const { key, ref } = restored.value;
      const current = owner
        .listWork()
        .find(
          (entry) => entry.key.documentId === key.documentId && entry.key.projectId === projectId,
        );
      if (!current) throw new Error("Local document lineage is unavailable");
      if (current.phase === "adopted") {
        await openDocument({ documentId: key.documentId, workId: editorWorkId });
        return;
      }
      await openTab(
        projectId,
        {
          kind: "new",
          documentId: key.documentId,
          name: current.work.desiredIdentity?.name ?? t`Untitled`,
          lineageHandle: ref.lineageHandle,
          identityRevision: current.identityRevision,
        },
        isCurrent,
      );
      if (isCurrent?.() === false) return;
      await selectTab(projectId, editorWorkId ?? "", key.documentId);
      if (isCurrent?.() === false) return;
      await openRoute?.({
        scheme: "unfiled",
        path: "",
        workId: editorWorkId,
        documentId: key.documentId,
      });
    } catch {
      if (isCurrent?.() !== false) setError(t`Couldn't open this local document. Try again.`);
    }
  }
  return (
    <>
      {documents.map((record) => (
        <Button
          key={record.key.documentId}
          variant="ghost"
          className="w-full justify-start px-6"
          onClick={() => void reopen(record)}
        >
          <FileText aria-hidden />
          <span className="truncate">{record.work.desiredIdentity?.name ?? t`Untitled`}</span>
        </Button>
      ))}
      {error ? (
        <p role="alert" className="px-6 text-sm text-muted-foreground">
          {error}
        </p>
      ) : null}
    </>
  );
}
