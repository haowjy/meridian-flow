/** The chats whose uploads a port can name: a handle to a chat id, and whether it is live. */

export interface ChatUploadsOwner {
  chatId: string;
  chatRef: string;
  /** False while the chat is in the trash: its uploads stay stored but unavailable. */
  live: boolean;
}

export interface ChatUploadsOwners {
  /** The primary chat of this project spelled `c12`; subagent handles never match. */
  byRef(projectId: string, ref: string): Promise<ChatUploadsOwner | null>;
}
