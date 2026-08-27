/** Neutral Project-chat projection shared by Home and Work feeds. */
import { z } from "zod";

export interface ProjectChatItem {
  id: string;
  title: string;
  work: { id: string; title: string } | null;
  lastMessagePreview: string | null;
  lastActivityAt: string;
  actionRequired: boolean;
  isFavorite: boolean;
}

export interface WorkChatFeedPage {
  items: ProjectChatItem[];
  nextCursor: string | null;
}

export interface HomeChatFeedPage {
  featured: {
    continueChat: ProjectChatItem | null;
    favoriteChats: ProjectChatItem[];
  } | null;
  recentChats: {
    items: ProjectChatItem[];
    nextCursor: string | null;
  };
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
