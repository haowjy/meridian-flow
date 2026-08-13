/** Server-owned projection used by the chat-first project Home. */
import { z } from "zod";

export type HomeChatAttention = "actionRequired" | "unread" | "none";

export interface HomeChatItem {
  id: string;
  title: string;
  work: { id: string; title: string } | null;
  lastMessagePreview: string | null;
  lastActivityAt: string;
  attention: HomeChatAttention;
  isFavorite: boolean;
}

export interface HomeChatFeedPage {
  featured: {
    continueChat: HomeChatItem | null;
    favoriteChats: HomeChatItem[];
  } | null;
  recentChats: {
    items: HomeChatItem[];
    nextCursor: string | null;
  };
}

export const updateThreadUserStateRequestSchema = z
  .object({
    isFavorite: z.boolean().optional(),
    isUnread: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.isFavorite !== undefined || value.isUnread !== undefined, {
    message: "At least one user-state field is required",
  });

export type UpdateThreadUserStateRequest = z.infer<typeof updateThreadUserStateRequestSchema>;

export interface UpdateThreadUserStateResponse {
  threadId: string;
  isFavorite: boolean;
  manuallyUnread: boolean;
  lastOpenedAt: string | null;
  attention: HomeChatAttention;
}
