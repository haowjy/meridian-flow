/** The chat index's loading rows, kept apart so row fixtures load without the composer. */
import { Trans } from "@lingui/react/macro";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectChatRowSkeleton } from "../chat-list/ProjectChatRow";

/** Loading anatomy matches a first group: its label, then rows at real rhythm. */
export function ChatIndexLoading() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">
        <Trans>Loading chats</Trans>
      </span>
      <div aria-hidden>
        <Skeleton className="h-3 w-14 motion-reduce:animate-none" />
        <ul className="-mx-2 mt-2 [--row-rule-inset:--spacing(2)]">
          {Array.from({ length: 5 }, (_, index) => (
            <ProjectChatRowSkeleton key={index} ruled={index < 4} />
          ))}
        </ul>
      </div>
    </div>
  );
}
