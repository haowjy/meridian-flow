/**
 * useCreateEntryForm — shared state machine for inline context entry creation.
 *
 * Owns name input state, validation (including sibling collision when sibling
 * names are provided), the create mutation, keyboard/blur commit semantics,
 * and autofocus. Both the desktop tree's CreateRow and the mobile browser's
 * MobileCreateRow render their own chrome around this hook's return value.
 *
 * Submit semantics: Enter commits; Escape cancels; blur-with-content commits
 * (unless Escape already cancelled). Empty submit = cancel. Blocking errors
 * (name collision, `/` in name) keep the row open and refocus the input.
 * Whitespace warnings commit (trimmed).
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { LucideIcon } from "lucide-react";
import { Folder } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";

import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";

import type { ContextCreateKind } from "./context-create-kind";
import {
  type ContextEntryNameSeverity,
  joinContextEntryPath,
  validateContextEntryName,
} from "./context-entry-name";
import { fileKindIcon } from "./context-file-icon";

export type UseCreateEntryFormOptions = {
  projectId: string;
  activeThreadId: string | null;
  scheme: ProjectContextTreeScheme;
  kind: ContextCreateKind;
  /** Parent folder path. Defaults to `""` (scheme root). */
  parent?: string;
  /** Sibling names for collision detection. Omit to skip collision checks. */
  siblingNames?: readonly string[];
  /** Called when the form completes (successful create or cancel). */
  onDone: () => void;
  /** Called after a successful create, with the new entry's path. */
  onCreated?: (path: string) => void;
};

export type CreateEntryForm = {
  name: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Current validation state. Null = valid or empty. Server errors surface here too. */
  severity: ContextEntryNameSeverity | null;
  isPending: boolean;
  /** Icon for the current kind + name (updates dynamically by extension). */
  icon: LucideIcon;
  placeholder: string;
  /** Input onChange — sets name and clears server errors. */
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** Input onKeyDown — Enter submits, Escape cancels. */
  onKeyDown: (event: KeyboardEvent) => void;
  /** Input onBlur — commits unless Escape already cancelled. */
  onBlur: () => void;
};

export function useCreateEntryForm({
  projectId,
  activeThreadId,
  scheme,
  kind,
  parent = "",
  siblingNames = [],
  onDone,
  onCreated,
}: UseCreateEntryFormOptions): CreateEntryForm {
  const [name, setName] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const mutation = useCreateContextEntry(projectId, scheme, { activeThreadId });

  // Auto-focus on mount. The rAF retry handles Radix menu focus scope
  // teardown — the menu's closing animation holds the scope for one frame,
  // swallowing a same-tick focus(). Harmless when no menu preceded the row.
  useEffect(() => {
    inputRef.current?.focus();
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  const severity: ContextEntryNameSeverity | null = serverError
    ? { level: "error", message: serverError }
    : validateContextEntryName(name, siblingNames);

  async function submit() {
    if (mutation.isPending) return;
    const trimmed = name.trim();
    if (!trimmed) {
      onDone();
      return;
    }
    const check = validateContextEntryName(name, siblingNames);
    if (check?.level === "error") {
      inputRef.current?.focus();
      return;
    }
    const path = joinContextEntryPath(parent, trimmed);
    try {
      await mutation.mutateAsync({ type: kind, path });
      onCreated?.(path);
      onDone();
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    name,
    inputRef,
    severity,
    isPending: mutation.isPending,
    icon: kind === "folder" ? Folder : fileKindIcon(name || "untitled.md"),
    placeholder: kind === "folder" ? t`Folder name` : t`File name`,
    onChange(event) {
      setName(event.target.value);
      if (serverError) setServerError(null);
    },
    onKeyDown(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        void submit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelledRef.current = true;
        onDone();
      }
    },
    onBlur() {
      if (cancelledRef.current) return;
      void submit();
    },
  };
}
