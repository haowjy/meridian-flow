/**
 * UnsentDraftTextNotice: a draft of this document closed (another device discarded it) while it
 * held typing from this browser that the server never took. The page has moved on; this keeps
 * the text in reach until the writer dismisses it.
 */
import { Trans, useLingui } from "@lingui/react/macro";
import { CircleAlert, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { CopyTextButton } from "@/components/app/CopyTextButton";
import { DocumentNotice } from "@/components/app/DocumentNotice";
import { IconButton } from "@/components/ui/icon-button";
import { useDraftCommandOwner } from "@/features/project/context/account-feature-context";

export function UnsentDraftTextNotice({
  projectId,
  documentId,
  className = "px-4 pt-3",
}: {
  projectId: string;
  documentId: string;
  /** The pane's inset: the desktop page's, or the phone's. */
  className?: string;
}) {
  const { t } = useLingui();
  const commands = useDraftCommandOwner();
  useSyncExternalStore(commands.subscribe, commands.snapshot, commands.snapshot);
  const unsent = commands.unsentText(projectId, documentId);
  if (!unsent) return null;
  return (
    <div className={className} data-unsent-draft-text>
      <DocumentNotice
        icon={<CircleAlert aria-hidden className="size-4" />}
        action={
          <div className="flex items-center gap-1">
            <CopyTextButton variant="outline" size="xs" text={unsent.text}>
              <Trans>Copy the draft's text</Trans>
            </CopyTextButton>
            <IconButton
              label={t`Dismiss`}
              onClick={() => commands.dismissUnsentText(projectId, documentId)}
            >
              <X aria-hidden />
            </IconButton>
          </div>
        }
      >
        <Trans>The draft was discarded before your latest typing reached it.</Trans>
      </DocumentNotice>
    </div>
  );
}
