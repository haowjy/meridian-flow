/**
 * Inline fixtures for the thread-info proto — no network, no query hooks.
 */
import type { RailDocument } from "@/features/chat/ThreadDocumentList";

export const MOCK_THREAD_TITLE = "Chapter 3 revisions";
export const MOCK_AGENT_INITIALS = "SE";
export const MOCK_AGENT_NAME = "Story Editor";

export const MOCK_UPLOADS: RailDocument[] = [
  {
    documentId: "upload-1",
    name: "chapter-3.mdx",
    extension: ".mdx",
    sizeBytes: 12 * 1024,
    editable: true,
    fileType: null,
  },
  {
    documentId: "upload-2",
    name: "outline.pdf",
    extension: ".pdf",
    sizeBytes: 240 * 1024,
    editable: false,
    fileType: "pdf",
  },
];

export const MOCK_RECENT_WRITES: RailDocument[] = [
  {
    documentId: "recent-1",
    name: "chapter-4.mdx",
    extension: ".mdx",
    sizeBytes: 8 * 1024,
    editable: true,
    fileType: null,
  },
  {
    documentId: "recent-2",
    name: "chapter-3.mdx",
    extension: ".mdx",
    sizeBytes: 12 * 1024,
    editable: true,
    fileType: null,
  },
];

export type MockThread = { id: string; title: string };

export type MockWorkGroup = { id: string; name: string; threads: MockThread[] };

export const MOCK_WORK_GROUPS: MockWorkGroup[] = [
  {
    id: "work-1",
    name: "Book One",
    threads: [
      { id: "thread-1", title: "Chapter 3 revisions" },
      { id: "thread-2", title: "Outline brainstorm" },
    ],
  },
];

export const MOCK_UNGROUPED_THREADS: MockThread[] = [{ id: "thread-3", title: "Character notes" }];

export const ACTIVE_THREAD_ID = "thread-1";
