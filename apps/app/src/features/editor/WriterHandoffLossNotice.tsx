/** Document-scoped handoff loss stays visible until dismissed, even after leaving review. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { IconButton } from "@/components/ui/icon-button";

export function WriterHandoffLossNotice({
  projectId,
  documentId,
}: {
  projectId: string;
  documentId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = projectQueryKeys.writerHandoffLoss(projectId, documentId);
  const { data: lost } = useQuery({
    queryKey,
    queryFn: () => false,
    enabled: false,
    gcTime: Infinity,
  });
  if (!lost) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-border bg-card px-4 py-2 text-caption text-ink-muted"
      data-writer-handoff-loss
    >
      <p className="flex-1">
        <Trans>Some typing inside a discarded change couldn't be kept.</Trans>
      </p>
      <IconButton
        tooltip={t`Dismiss typing notice`}
        size="sm"
        onClick={() => queryClient.setQueryData(queryKey, false)}
      >
        <X className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}
