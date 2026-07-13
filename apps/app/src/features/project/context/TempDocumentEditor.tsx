/** Standalone editor and guarded project-save flow for a device-local document. */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { mdxCodec } from "@meridian/markup";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useCreateContextEntry } from "@/client/query/useCreateContextEntry";
import { type TempDocument, useTempDocsStore } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { EditorToolbar } from "@/features/editor/EditorToolbar";
import { invalidContextEntryNameReason, joinContextEntryPath } from "./context-entry-name";
import { schemeLabel } from "./context-schemes";
import { type FileSuggestion, FileSuggestionList, useFileSuggestions } from "./file-suggestions";
import {
  initialTempDocumentName,
  takeTempDocumentNameOwnership,
  updateSuggestedTempDocumentName,
} from "./temp-document-name";
import "@/features/editor/editor.css";

const DURABLE_SCHEMES = ["manuscript", "kb", "user"] as const;
type Destination = { scheme: ProjectContextTreeScheme; path: string };
type SaveSnapshot = {
  documentId: string;
  content: string;
  destination: Destination;
  name: string;
  revision: number;
};
type SaveState =
  | { kind: "editing" }
  | { kind: "saving"; snapshot: SaveSnapshot }
  | { kind: "conflict"; snapshot: SaveSnapshot; path: string }
  | { kind: "failed"; reason: "generic" | "newer-words" };
let lastSuccessfulDestination: Destination = { scheme: "manuscript", path: "/" };

export function TempDocumentEditor({
  projectId,
  activeThreadId,
  document,
  onOpenSaved,
  onVerificationFailed,
}: {
  projectId: string;
  activeThreadId: string | null;
  document: TempDocument;
  onOpenSaved: (scheme: ProjectContextTreeScheme, path: string) => void;
  onVerificationFailed: () => void;
}) {
  const updateTemp = useTempDocsStore((state) => state.updateTemp);
  const updateSaveName = useTempDocsStore((state) => state.updateSaveName);
  const removeTemp = useTempDocsStore((state) => state.removeTemp);
  const [destination, setDestination] = useState<Destination>(lastSuccessfulDestination);
  const [destinationText, setDestinationText] = useState(() => formatDestination(destination));
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "editing" });
  const [nameState, setNameState] = useState(() =>
    document.saveName === undefined
      ? initialTempDocumentName(document.content, document.name)
      : { value: document.saveName, owned: document.saveNameOwned ?? false },
  );
  const nameStateRef = useRef(nameState);
  nameStateRef.current = nameState;
  const nameInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const mutation = useCreateContextEntry(projectId, destination.scheme, { activeThreadId });
  const { suggestions } = useFileSuggestions(projectId, destinationText, {
    schemes: DURABLE_SCHEMES,
    kinds: ["dir"],
    activeThreadId,
  });
  const editor = useEditor({
    extensions: createStandaloneEditorExtensions(),
    content: document.content,
    autofocus: true,
    editorProps: {
      attributes: {
        class: "prose-tokens focus-ring min-h-full px-6 py-6 md:px-10 md:py-8",
        "aria-label": t`Temporary document editor`,
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      const content = updatedEditor.getJSON();
      updateTemp(projectId, document.id, content);
      const nextName = updateSuggestedTempDocumentName(nameStateRef.current, content);
      if (nextName.value !== nameStateRef.current.value) {
        nameStateRef.current = nextName;
        setNameState(nextName);
        updateSaveName(projectId, document.id, nextName.value, nextName.owned);
      }
    },
  });

  useEffect(() => () => editor?.destroy(), [editor]);

  const selectDestination = (suggestion: FileSuggestion) => {
    const next = { scheme: suggestion.scheme, path: suggestion.path };
    setDestination(next);
    setDestinationText(formatDestination(next));
    setDestinationOpen(false);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  };

  const clearFailure = () => setSaveState({ kind: "editing" });

  async function save() {
    if (saveState.kind === "saving") return;
    const trimmed = nameState.value.trim();
    const validation = trimmed ? invalidContextEntryNameReason(trimmed) : t`Name is required`;
    if (validation) {
      setSaveState({ kind: "failed", reason: "generic" });
      return;
    }
    if (!editor) return;
    const path = joinContextEntryPath(destination.path, trimmed);
    const snapshot: SaveSnapshot = {
      documentId: document.id,
      content: mdxCodec({ schema: editor.schema }).serialize(
        Array.from({ length: editor.state.doc.childCount }, (_, index) =>
          editor.state.doc.child(index),
        ),
      ),
      destination,
      name: trimmed,
      revision: document.revision,
    };
    setSaveState({ kind: "saving", snapshot });
    try {
      const result = await mutation.mutateAsync({ type: "file", path, content: snapshot.content });
      if (result.status === "conflict") {
        setSaveState({ kind: "conflict", snapshot, path });
        return;
      }
      lastSuccessfulDestination = destination;
      onOpenSaved(destination.scheme, path);
      const current = useTempDocsStore
        .getState()
        .byProject[projectId]?.find((candidate) => candidate.id === snapshot.documentId);
      if (current?.revision === snapshot.revision) {
        removeTemp(projectId, snapshot.documentId);
      } else {
        setSaveState({ kind: "failed", reason: "newer-words" });
        onVerificationFailed();
      }
    } catch {
      setSaveState({ kind: "failed", reason: "generic" });
      onVerificationFailed();
    }
  }

  const saving = saveState.kind === "saving";
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <section
        className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-subtle px-3 py-2"
        aria-label={t`Save temporary document`}
      >
        <p className="mr-auto text-xs text-muted-foreground">
          <Trans>Not saved to your project yet.</Trans>
        </p>
        <Popover open={destinationOpen} onOpenChange={setDestinationOpen}>
          <PopoverAnchor asChild>
            <Input
              className="h-8 w-52"
              aria-label={t`Destination folder`}
              autoComplete="off"
              value={destinationText}
              onFocus={(event) => {
                setDestinationOpen(true);
                event.currentTarget.select();
              }}
              onChange={(event) => {
                setDestinationText(event.target.value);
                setDestinationOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setDestinationOpen(false);
                if (event.key !== "ArrowDown" || !destinationOpen) return;
                event.preventDefault();
                suggestionsRef.current
                  ?.querySelector<HTMLButtonElement>("[data-file-suggestion]")
                  ?.focus();
              }}
            />
          </PopoverAnchor>
          <PopoverContent
            ref={suggestionsRef}
            align="start"
            className="max-h-64 overflow-y-auto p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <FileSuggestionList
              suggestions={suggestions}
              onSelect={selectDestination}
              onClose={() => setDestinationOpen(false)}
              emptyMessage={t`No matching folders`}
            />
          </PopoverContent>
        </Popover>
        <Input
          ref={nameInputRef}
          className="h-8 w-44"
          aria-label={t`File name`}
          value={nameState.value}
          onChange={(event) => {
            const next = takeTempDocumentNameOwnership(nameState, event.target.value);
            nameStateRef.current = next;
            setNameState(next);
            updateSaveName(projectId, document.id, next.value, next.owned);
            clearFailure();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
          }}
          aria-invalid={saveState.kind === "failed" || saveState.kind === "conflict"}
        />
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        {saveState.kind === "failed" || saveState.kind === "conflict" ? (
          <SaveFailure
            state={saveState}
            onOpenExisting={onOpenSaved}
            onRename={() => nameInputRef.current?.focus()}
          />
        ) : null}
      </section>
      <EditorToolbar editor={editor} />
      <div data-stable-layout-scroll className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} className="min-h-full" />
      </div>
    </div>
  );
}

function SaveFailure({
  state,
  onOpenExisting,
  onRename,
}: {
  state: Extract<SaveState, { kind: "conflict" | "failed" }>;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
  onRename: () => void;
}) {
  if (state.kind === "failed") {
    return (
      <p className="basis-full text-right text-destructive text-xs" role="alert">
        {state.reason === "newer-words" ? (
          <Trans>Saved the snapshot and kept your newer words here.</Trans>
        ) : (
          <Trans>
            Couldn't save to your project. Nothing was lost — your words are still here.
          </Trans>
        )}
      </p>
    );
  }
  return (
    <div className="flex basis-full items-center justify-end gap-2 text-xs" role="alert">
      <p className="text-destructive">
        <Trans>
          “{state.snapshot.name}” already exists in {formatDestination(state.snapshot.destination)}.
        </Trans>
      </p>
      <Button
        size="xs"
        variant="quiet"
        onClick={() => onOpenExisting(state.snapshot.destination.scheme, state.path)}
      >
        <Trans>Open existing</Trans>
      </Button>
      <Button size="xs" variant="quiet" onClick={onRename}>
        <Trans>Rename</Trans>
      </Button>
    </div>
  );
}

function formatDestination(destination: Destination): string {
  const segments = destination.path.split("/").filter(Boolean);
  return [schemeLabel(destination.scheme), ...segments].join(" / ");
}
