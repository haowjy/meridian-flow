/**
 * The editor a document host shows, for the chrome around it (the band, the change card, the
 * phone's bar and sheet): in suggestion mode the review lives in that editor's document, so they
 * read it there. One per host, beside its review (`DocumentReview`).
 */
import type { Editor } from "@tiptap/core";
import { createContext, useContext, useSyncExternalStore } from "react";

export class HostEditor {
  private editor: Editor | null = null;
  private readonly listeners = new Set<() => void>();

  /** `editor` is the host's now; null releases `was`, unless another editor already took over. */
  set(editor: Editor | null, was?: Editor): void {
    if (this.editor === editor || (editor === null && was && this.editor !== was)) return;
    this.editor = editor;
    for (const listener of this.listeners) listener();
  }

  get = (): Editor | null => this.editor;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const HostEditorContext = createContext<HostEditor | null>(null);

const nothing = () => () => undefined;

/** The host's editor, once it is built; null outside a document host. */
export function useHostEditor(): Editor | null {
  const host = useContext(HostEditorContext);
  return useSyncExternalStore(host?.subscribe ?? nothing, host?.get ?? (() => null), () => null);
}

export function useHostEditorStore(): HostEditor | null {
  return useContext(HostEditorContext);
}
