/** Tab-local note above the New chat box that received a deleted chat's words. */
import { Trans } from "@lingui/react/macro";
import type { DeletedChatCard as Notice } from "@/client/composer-drafts";
import { FailureCard } from "@/components/app/FailureCard";

export function DeletedChatCard({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const title = notice.title;
  return (
    <FailureCard tone="info" onDismiss={onDismiss}>
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
    </FailureCard>
  );
}
