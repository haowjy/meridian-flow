import { Trans } from "@lingui/react/macro";
import type { DeletedChatCard as Notice } from "@/client/composer-drafts";
import { FailureCard } from "@/components/app/FailureCard";

export function DeletedChatCard({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const { title, count, own } = notice;
  return (
    <FailureCard tone="info" onDismiss={onDismiss}>
      <p className="min-w-0 flex-1 break-words">
        {own ? (
          title ? (
            <Trans>
              Your unsent words from <strong>{title}</strong> are below.
            </Trans>
          ) : (
            <Trans>Your unsent words from the chat you deleted are below.</Trans>
          )
        ) : (
          <>
            {title ? (
              <Trans>
                <strong>{title}</strong> was deleted.
              </Trans>
            ) : (
              <Trans>A chat you had open was deleted.</Trans>
            )}{" "}
            {count > 1 ? (
              <Trans>Your messages are below.</Trans>
            ) : (
              <Trans>Your message is below.</Trans>
            )}
          </>
        )}
      </p>
    </FailureCard>
  );
}
