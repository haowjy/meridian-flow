/** Neutral Project-chat projection shared by Home and Work feeds. */
import { z } from "zod";
import type { ThreadAttention } from "./projections.js";

export interface ProjectChatItem {
  id: string;
  title: string;
  work: { id: string; title: string } | null;
  lastMessagePreview: string | null;
  lastActivityAt: string;
  attention: ThreadAttention;
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
  attention: ThreadAttention;
}
