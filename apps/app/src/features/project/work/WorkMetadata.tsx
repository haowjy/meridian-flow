/**
 * Page-scoped Work description editing lifecycle. The name is renamed in the
 * band's title tab; this owns the description, which never saves on blur and
 * so guards navigation while a draft is dirty.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineEditTextarea } from "@/components/ui/inline-edit";
import { cn } from "@/lib/utils";

type HeldIntent = { run: () => void; cancel?: () => void; label: string } | null;

export function useWorkMetadataController(
  initial: Work,
  saveWork: (data: UpdateWorkRequest) => Promise<Work>,
) {
  const [work, setWork] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldIntent>(null);
  const heldRef = useRef<HeldIntent>(null);
  const takeHeld = useCallback(() => {
    const intent = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    return intent;
  }, []);
  useEffect(
    () => () => {
      heldRef.current?.cancel?.();
      heldRef.current = null;
    },
    [],
  );
  const [announcement, setAnnouncement] = useState("");
  const displayRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const initialRef = useRef(initial);
  const dirty = editing && draft.trim() !== (work.goal ?? "").trim();
  useEffect(() => {
    if (sameMetadata(initialRef.current, initial)) return;
    initialRef.current = initial;
    setWork(initial);
  }, [initial]);
  useEffect(() => {
    if (!saving && !editing && held) takeHeld()?.run();
  }, [editing, held, saving, takeHeld]);
  const focusDisplay = useCallback(
    () => requestAnimationFrame(() => displayRef.current?.focus()),
    [],
  );
  const cancel = useCallback(() => {
    if (!editing || saving) return;
    setEditing(false);
    setError(null);
    takeHeld()?.cancel?.();
    setAnnouncement(t`Description edit canceled`);
    focusDisplay();
  }, [editing, focusDisplay, saving, takeHeld]);
  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return true;
    if (saving) return false;
    if (!dirty) {
      setEditing(false);
      setError(null);
      focusDisplay();
      return true;
    }
    const goal = draft.trim();
    const previous = work;
    setWork({ ...work, goal, updatedAt: new Date().toISOString() });
    setSaving(true);
    setError(null);
    try {
      const returned = await saveWork({ goal });
      setWork(returned);
      setEditing(false);
      setAnnouncement(t`Description saved`);
      focusDisplay();
      return true;
    } catch (cause) {
      setWork(previous);
      setError(cause instanceof Error ? cause.message : t`Save failed`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, editing, focusDisplay, saveWork, saving, work]);
  const request = useCallback(
    (intent: NonNullable<HeldIntent>) => {
      const previous = heldRef.current;
      heldRef.current = intent;
      setHeld(intent);
      previous?.cancel?.();
      if (!saving && !dirty && heldRef.current === intent) takeHeld()?.run();
    },
    [dirty, saving, takeHeld],
  );
  const activate = useCallback(
    () =>
      request({
        label: t`Edit Description`,
        run: () => {
          setEditing(true);
          setDraft(work.goal ?? "");
          setError(null);
        },
      }),
    [request, work],
  );
  const saveAndResume = useCallback(async () => {
    const intent = heldRef.current;
    if (intent && (await save()) && heldRef.current === intent) takeHeld()?.run();
  }, [save, takeHeld]);
  const discardAndResume = useCallback(() => {
    if (!heldRef.current || saving) return;
    setEditing(false);
    setError(null);
    takeHeld()?.run();
  }, [saving, takeHeld]);
  const keepEditing = useCallback(() => {
    takeHeld()?.cancel?.();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [takeHeld]);
  return {
    work,
    editing,
    draft,
    setDraft,
    dirty,
    saving,
    error,
    held,
    announcement,
    editorRef,
    displayRef,
    activate,
    cancel,
    save,
    request,
    saveAndResume,
    discardAndResume,
    keepEditing,
  };
}
export type WorkMetadataController = ReturnType<typeof useWorkMetadataController>;

// Typography lives on the wrapper so the resting button and the editing field
// both inherit it; the field then sets no font of its own.
const bodyText = "max-w-3xl whitespace-pre-wrap break-words";
const clampHeight = "max-h-[calc(var(--text-body--line-height)*3)]";

/**
 * The Work description: body text clamped to three lines with Show more.
 * Clicking it edits in place; the field takes the text's exact position and
 * size, then shows everything. Save and Cancel sit below; blur never saves.
 */
export function WorkDescription({ controller: c }: { controller: WorkMetadataController }) {
  const display = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    if (!c.editing) return;
    const editor = c.editorRef.current;
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
  }, [c.editing, c.editorRef]);
  useEffect(() => {
    const node = display.current;
    if (c.editing || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!expanded) setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    if (expanded) setOverflows(true);
    else measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [c.editing, c.work.goal, expanded]);
  return (
    <div className="min-w-0 text-body text-foreground">
      <p className="sr-only" aria-live="polite">
        {c.announcement}
      </p>
      {c.editing ? (
        <DescriptionEditor controller={c} />
      ) : (
        <>
          <button
            type="button"
            ref={(node) => {
              display.current = node;
              c.displayRef.current = node;
            }}
            onClick={c.activate}
            className={cn(
              bodyText,
              "inline-edit-trigger focus-ring block w-full overflow-hidden text-left [@media(pointer:coarse)]:min-h-11",
              !expanded && clampHeight,
              overflows &&
                !expanded &&
                "[mask-image:linear-gradient(to_bottom,#000_55%,transparent)]",
              !c.work.goal && "text-muted-foreground",
            )}
          >
            {c.work.goal || t`Add a description of what this Work is for`}
          </button>
          {overflows ? (
            <button
              type="button"
              className="text-button mt-1 min-h-6 text-sm [@media(pointer:coarse)]:min-h-11"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function DescriptionEditor({ controller: c }: { controller: WorkMetadataController }) {
  const errorId = "work-description-error";
  return (
    <>
      <InlineEditTextarea
        ref={c.editorRef}
        value={c.draft}
        disabled={c.saving}
        aria-label={t`Description`}
        aria-invalid={Boolean(c.error)}
        aria-describedby={c.error ? errorId : undefined}
        placeholder={t`Add a description of what this Work is for`}
        onChange={(event) => c.setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            c.cancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void c.save();
          }
        }}
        className={bodyText}
      />
      {c.error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-destructive">
          {c.error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={c.saving} onClick={() => void c.save()}>
          {c.saving ? (
            <Trans>Saving…</Trans>
          ) : c.error ? (
            <Trans>Retry save</Trans>
          ) : (
            <Trans>Save</Trans>
          )}
        </Button>
        <Button size="sm" variant="ghost" disabled={c.saving} onClick={c.cancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </>
  );
}

function sameMetadata(a: Work, b: Work) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.goal === b.goal &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt
  );
}
