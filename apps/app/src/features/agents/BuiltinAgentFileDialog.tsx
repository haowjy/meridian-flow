import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { AgentFileStatus } from "@meridian/contracts/agents";
import { useBuiltinAgentFile } from "@/client/query/useAgentFiles";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { role } from "@/components/ui/roles";
import { AgentFileStatusNotice } from "./AgentFileNotice";

/**
 * A built-in Agent or skill opens here, read-only: it is no document, so it has no main address,
 * as a chat's upload has none.
 */
export function BuiltinAgentFileDialog({
  file,
  onClose,
}: {
  file: AgentFileStatus | null;
  onClose: () => void;
}) {
  const text = useBuiltinAgentFile(file?.path ?? null);
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-lg p-0">
        {file ? (
          <>
            <DialogTitle className="truncate border-b border-border-subtle py-3 pr-12 pl-4 text-sm font-medium">
              {file.slug}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {file.kind === "agent" ? t`Built-in Agent, read-only` : t`Built-in skill, read-only`}
            </DialogDescription>
            <AgentFileStatusNotice file={file} className="mx-4 mt-3" />
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {text.isError ? (
                <InlineErrorRow message={t`Couldn't load this file.`} className="p-0" />
              ) : text.data === undefined ? (
                <p role="status" className={role.emptyLine}>
                  <Trans>Loading…</Trans>
                </p>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-foreground">
                  {text.data}
                </pre>
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
