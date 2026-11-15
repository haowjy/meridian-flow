import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useState } from "react";
import { useThreadAgent } from "@/client/query/useAgentFiles";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { Chip } from "@/components/ui/chip";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { role } from "@/components/ui/roles";

/**
 * Where a chat shows the Agent definition it is bound to, read-only. It offers nothing: a newer
 * save takes over when the chat compacts, so the mark only says why the chat still runs the old text.
 */
export function ThreadAgentDefinition({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const agent = useThreadAgent(open ? threadId : null);
  return (
    <>
      <button
        type="button"
        className="mt-1 w-full border-t border-border-subtle px-3 py-2 text-left text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <Trans>View this chat's Agent definition</Trans>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[min(48rem,calc(100dvh-2rem))] max-w-[min(56rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden rounded-lg p-0">
          <DialogTitle className="flex items-center gap-2 truncate border-b border-border-subtle py-3 pr-12 pl-4 text-sm font-medium">
            {agent.data?.name ?? t`Agent definition`}
            {agent.data?.stale ? (
              <Chip kind="label">
                <Trans>A newer version is saved</Trans>
              </Chip>
            ) : null}
          </DialogTitle>
          <DialogDescription className="sr-only">
            <Trans>The Agent definition this chat runs, read-only.</Trans>
          </DialogDescription>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {agent.isError ? (
              <InlineErrorRow message={t`Couldn't load this definition.`} className="p-0" />
            ) : agent.data === undefined ? (
              <p role="status" className={role.emptyLine}>
                <Trans>Loading…</Trans>
              </p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-foreground">
                {agent.data.text}
              </pre>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
