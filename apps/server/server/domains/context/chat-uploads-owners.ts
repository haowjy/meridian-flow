export interface ChatUploadsOwner {
  chatId: string;
  chatRef: string;
  live: boolean;
  title?: string | null;
}

export interface ChatUploadsOwners {
  byRef(projectId: string, ref: string): Promise<ChatUploadsOwner | null>;
}
