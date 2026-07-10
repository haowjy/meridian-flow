/**
 * Purpose: Defines thread list projection DTOs shared by backend repository adapters and clients.
 * Why independent: List rows carry denormalized work and lifecycle state that should not bloat the canonical Thread entity.
 */
import type { Thread } from "./index.js";

export type ThreadAttention = "actionRequired" | "unread" | "none";

export interface ThreadListWork {
  id: string;
  title: string;
}

export interface ThreadListItem extends Thread {
  work: ThreadListWork | null;
  attention: ThreadAttention;
  runningTurnId: string | null;
}
