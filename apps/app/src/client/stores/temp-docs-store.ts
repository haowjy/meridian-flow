/** Device-local temporary documents. They never acquire a context URI. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { JSONContent } from "@tiptap/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TempDocumentSaveFailure =
  | { kind: "generic" }
  | {
      kind: "collision";
      scheme: ProjectContextTreeScheme;
      path: string;
      name: string;
      destination: string;
    };

export type TempDocument = {
  id: string;
  name: string;
  content: JSONContent;
  saveName?: string;
  saveNameOwned?: boolean;
  saveFailure?: TempDocumentSaveFailure;
};
type State = {
  byProject: Record<string, TempDocument[]>;
  createTemp: (projectId: string) => TempDocument;
  updateTemp: (projectId: string, id: string, content: JSONContent) => void;
  updateSaveName: (projectId: string, id: string, saveName: string, owned: boolean) => void;
  setSaveFailure: (projectId: string, id: string, failure?: TempDocumentSaveFailure) => void;
  removeTemp: (projectId: string, id: string) => void;
};

export function nextUntitledName(documents: readonly TempDocument[]): string {
  const names = new Set(documents.map((document) => document.name));
  if (!names.has("Untitled")) return "Untitled";
  let suffix = 2;
  while (names.has(`Untitled ${suffix}`)) suffix += 1;
  return `Untitled ${suffix}`;
}

const emptyContent: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

export const useTempDocsStore = create<State>()(
  persist(
    (set, get) => ({
      byProject: {},
      createTemp: (projectId) => {
        const documents = get().byProject[projectId] ?? [];
        const document = {
          id: crypto.randomUUID(),
          name: nextUntitledName(documents),
          content: emptyContent,
        };
        set((state) => ({
          byProject: { ...state.byProject, [projectId]: [...documents, document] },
        }));
        return document;
      },
      updateTemp: (projectId, id, content) =>
        set((state) => ({
          byProject: {
            ...state.byProject,
            [projectId]: (state.byProject[projectId] ?? []).map((document) =>
              document.id === id ? { ...document, content } : document,
            ),
          },
        })),
      updateSaveName: (projectId, id, saveName, owned) =>
        set((state) => ({
          byProject: {
            ...state.byProject,
            [projectId]: (state.byProject[projectId] ?? []).map((document) =>
              document.id === id ? { ...document, saveName, saveNameOwned: owned } : document,
            ),
          },
        })),
      setSaveFailure: (projectId, id, failure) =>
        set((state) => ({
          byProject: {
            ...state.byProject,
            [projectId]: (state.byProject[projectId] ?? []).map((document) =>
              document.id === id ? { ...document, saveFailure: failure } : document,
            ),
          },
        })),
      removeTemp: (projectId, id) =>
        set((state) => ({
          byProject: {
            ...state.byProject,
            [projectId]: (state.byProject[projectId] ?? []).filter(
              (document) => document.id !== id,
            ),
          },
        })),
    }),
    { name: "temp-documents" },
  ),
);
