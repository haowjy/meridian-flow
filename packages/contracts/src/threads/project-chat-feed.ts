/** Neutral Project-chat projection shared by Project and Work feeds. */
import { z } from "zod";

export interface ProjectChatItem {
  id: string;
  title: string;
  work: { id: string; title: string } | null;
  /** Bound Agent display name; null when the binding join has no name. */
  agentName: string | null;
  lastMessagePreview: string | null;
  lastActivityAt: string;
  actionRequired: boolean;
  isFavorite: boolean;
}

/** One keyset page of project chats: the chat index's feed or one Work's chats. */
export interface ProjectChatFeedPage {
  items: ProjectChatItem[];
  nextCursor: string | null;
}

export const updateThreadUserStateRequestSchema = z
  .object({
    isFavorite: z.boolean(),
  })
  .strict();

export type UpdateThreadUserStateRequest = z.infer<typeof updateThreadUserStateRequestSchema>;

export interface UpdateThreadUserStateResponse {
  threadId: string;
  isFavorite: boolean;
}
