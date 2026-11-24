import { z } from "zod";

export interface ProjectChatItem {
  id: string;
  title: string;
  work: { id: string; title: string } | null;
  agentName: string | null;
  lastMessagePreview: string | null;
  lastActivityAt: string;
  actionRequired: boolean;
  isFavorite: boolean;
}

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
