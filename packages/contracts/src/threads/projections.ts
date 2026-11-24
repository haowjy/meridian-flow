import type { Thread } from "./index.js";

export interface ThreadListWork {
  id: string;
  title: string;
}

export interface ThreadListItem extends Thread {
  work: ThreadListWork | null;
  actionRequired: boolean;
  runningTurnId: string | null;
}
