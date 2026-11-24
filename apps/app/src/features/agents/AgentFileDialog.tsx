import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ReactNode } from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { ViewerDialog } from "@/components/app/ViewerDialog";
import { role } from "@/components/ui/roles";

export function AgentFileDialog({
  open,
  onClose,
  title,
  titleExtra,
  description,
  text,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleExtra?: ReactNode;
  description: string;
  text: { isError: boolean; data: string | undefined };
}) {
  return (
    <ViewerDialog
      open={open}
      onClose={onClose}
      title={title}
      titleExtra={titleExtra}
      description={description}
    >
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
    </ViewerDialog>
  );
}
