/**
 * MobileDocumentHost — resolves phone route documents into shared read-only content.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { AlertCircle, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { findContextFile } from "../context/context-tree";
import { ReadOnlyDocHost } from "../context/ReadOnlyDocHost";

const MOBILE_DOCUMENT_OWNER = "mobile-project-document-host";

export type MobileDocumentHostProps = {
  projectId: string;
  activeThreadId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
};

export function MobileDocumentHost({
  projectId,
  activeThreadId,
  activeContextScheme,
  activeContextPath,
}: MobileDocumentHostProps) {
  const workId = useContextWorkId(projectId, activeThreadId);
  const hasRouteDocument = activeContextScheme !== null && activeContextPath !== null;
  const { tree, isError, isFetching } = useProjectContextTree(
    projectId,
    activeContextScheme ?? "kb",
    { enabled: hasRouteDocument, activeThreadId },
  );

  const activeTab = useMemo(() => {
    if (!hasRouteDocument || activeContextScheme === null || activeContextPath === null || !tree) {
      return null;
    }
    const file = findContextFile(tree, activeContextPath);
    return file ? contextTabFromFile(activeContextScheme, file, workId) : null;
  }, [activeContextPath, activeContextScheme, hasRouteDocument, tree, workId]);

  if (!activeContextScheme || !activeContextPath) {
    return (
      <DocumentStatus tone="muted">
        <Trans>Select a document.</Trans>
      </DocumentStatus>
    );
  }

  if (!activeTab) {
    if (isFetching && !tree) {
      return (
        <DocumentStatus tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </DocumentStatus>
      );
    }
    if (isError || tree) {
      return (
        <DocumentStatus tone="error">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </DocumentStatus>
      );
    }
    return null;
  }

  return (
    <ReadOnlyDocHost
      projectId={projectId}
      activeThreadId={activeThreadId}
      tab={activeTab}
      registryOwner={MOBILE_DOCUMENT_OWNER}
    />
  );
}

function DocumentStatus({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={
        tone === "error"
          ? "grid h-full place-items-center px-6 text-center text-sm text-destructive"
          : "grid h-full place-items-center px-6 text-center text-sm text-muted-foreground"
      }
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
