/** Tab-local explanation above the New chat box that received deleted-chat words. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { X } from "lucide-react";
import type { DeletedChatNotice as Notice } from "@/client/composer-drafts";
import { IconButton } from "@/components/ui/icon-button";

export function DeletedChatNotice({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const title = notice.title;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-field border border-border bg-muted px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)] text-compact text-ink-muted"
    >
      <p className="min-w-0 flex-1 break-words">
        {title ? (
          <Trans>
            <strong>{title}</strong> was deleted.
          </Trans>
        ) : (
          <Trans>A chat you had open was deleted.</Trans>
        )}{" "}
        {notice.count > 1 ? (
          <Trans>Your messages are below.</Trans>
        ) : (
          <Trans>Your message is below.</Trans>
        )}
      </p>
      <IconButton tooltip={t`Dismiss`} onClick={onDismiss} className="shrink-0">
        <X aria-hidden className="size-3.5" />
      </IconButton>
    </div>
  );
}
