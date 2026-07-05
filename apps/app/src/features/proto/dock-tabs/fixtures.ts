/** Hardcoded fixture data for the /proto/dock-tabs throwaway mockup. */

export type ProtoArrangement = "chat-main" | "context-main";

export type DockTabId = "context" | "chat" | "changes";

export type ChangeRow = {
  id: string;
  verb: string;
  excerpt: string;
  added: number;
  removed: number;
};

export type DocumentChanges = {
  documentId: string;
  title: string;
  added: number;
  removed: number;
  changes: ChangeRow[];
};

export const PENDING_CHANGE_COUNT = 5;

export const DOCUMENT_CHANGES: DocumentChanges[] = [
  {
    documentId: "ch-1",
    title: "Chapter 1 — The Waste Who Would Be Immortal",
    added: 100,
    removed: 103,
    changes: [
      {
        id: "ch1-c1",
        verb: "Rewrote",
        excerpt: "The apprentice whispers RIVERSTONE before the gate…",
        added: 42,
        removed: 40,
      },
      {
        id: "ch1-c2",
        verb: "Added",
        excerpt: "Morning mist clung to the broken stair…",
        added: 18,
        removed: 0,
      },
      {
        id: "ch1-c3",
        verb: "Removed",
        excerpt: "He had no name worth keeping.",
        added: 0,
        removed: 15,
      },
      {
        id: "ch1-c4",
        verb: "Rewrote",
        excerpt: "The elders called him waste, yet the river…",
        added: 40,
        removed: 48,
      },
    ],
  },
  {
    documentId: "ch-2",
    title: "Chapter 2 — Ash on the Jade Steps",
    added: 37,
    removed: 0,
    changes: [
      {
        id: "ch2-c1",
        verb: "Added",
        excerpt: "Dawn found Ling Mei kneeling where the jade…",
        added: 37,
        removed: 0,
      },
    ],
  },
];
