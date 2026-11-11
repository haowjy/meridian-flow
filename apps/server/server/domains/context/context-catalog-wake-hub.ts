/** Context-owned lossy live fan-out for catalog wake hints over authenticated transports. */
import type { CatalogChannelMessage } from "@meridian/contracts/protocol";
import type { ContextCatalogWakePort } from "./ports/context-catalog.js";

type Subscriber = {
  projectId: string;
  userId: string;
  listener: (hint: CatalogChannelMessage) => void;
};

export type ContextCatalogWakeHub = ContextCatalogWakePort & {
  subscribe(input: Subscriber): () => void;
};

export function createContextCatalogWakeHub(): ContextCatalogWakeHub {
  const subscribers = new Set<Subscriber>();
  return {
    publish(hint) {
      for (const subscriber of subscribers) {
        const matches =
          hint.type === "draft-owner-hint" || hint.type === "project-chats-hint"
            ? hint.projectId === subscriber.projectId
            : hint.scope.kind === "user"
              ? hint.scope.userId === subscriber.userId
              : hint.scope.projectId === subscriber.projectId;
        if (!matches) continue;
        try {
          subscriber.listener(hint);
        } catch {
          // Hints contain no truth and are repaired by focus/poll acquisition.
        }
      }
    },
    subscribe(input) {
      subscribers.add(input);
      return () => subscribers.delete(input);
    },
  };
}
