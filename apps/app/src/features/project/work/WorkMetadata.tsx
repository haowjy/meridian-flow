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

type HeldIntent = { run: () => void; cancel: () => void };

export function useWorkMetadataController(
  work: Work,
  saveWork: (data: UpdateWorkRequest) => Promise<Work>,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasPendingIntent, setHasPendingIntent] = useState(false);
  const heldRef = useRef<HeldIntent>(null);
  const takeHeld = useCallback(() => {
    const intent = heldRef.current;
    heldRef.current = null;
    setHasPendingIntent(false);
    return intent;
  }, []);
  useEffect(
    () => () => {
      heldRef.current?.cancel();
      heldRef.current = null;
    },
    [],
  );
  const [announcement, setAnnouncement] = useState("");
  const displayRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = editing && draft.trim() !== (work.goal ?? "").trim();
  const focusDisplay = useCallback(
    () => requestAnimationFrame(() => displayRef.current?.focus()),
    [],
  );
  const cancel = useCallback(() => {
    if (!editing || saving) return;
    setEditing(false);
    setError(null);
    takeHeld()?.cancel();
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
    setSaving(true);
    setError(null);
    try {
      await saveWork({ goal });
      setEditing(false);
      setAnnouncement(t`Description saved`);
      focusDisplay();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Save failed`);
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, editing, focusDisplay, saveWork, saving]);
  const request = useCallback(
    (intent: HeldIntent) => {
      if (!dirty) {
        intent.run();
        return;
      }
      const previous = heldRef.current;
      heldRef.current = intent;
      setHasPendingIntent(true);
      previous?.cancel();
    },
    [dirty],
  );
  const activate = useCallback(() => {
    setEditing(true);
    setDraft(work.goal ?? "");
    setError(null);
  }, [work.goal]);
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
    takeHeld()?.cancel();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [takeHeld]);
  return {
    editing,
    draft,
    setDraft,
    dirty,
    saving,
    error,
    held: hasPendingIntent,
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
 * The Work description: body text clamped to three lines. Clicking a clamped
 * description shows all of it; Show less folds it again. Edit (or clicking an
 * empty description) edits in place: the field takes the text's exact position
 * and size. Save and Cancel sit below; blur never saves.
 */
export function WorkDescription({
  work,
  controller: c,
}: {
  work: Work;
  controller: WorkMetadataController;
}) {
  const display = useRef<HTMLDivElement | null>(null);
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
  }, [c.editing, work.goal, expanded]);
  const clamped = overflows && !expanded;
  const bindEditFocus = (node: HTMLButtonElement | null) => {
    c.displayRef.current = node;
  };
  return (
    <div className="min-w-0 text-body text-foreground">
      <p className="sr-only" aria-live="polite">
        {c.announcement}
      </p>
      {c.editing ? (
        <DescriptionEditor controller={c} />
      ) : !work.goal ? (
        <button
          type="button"
          ref={bindEditFocus}
          onClick={c.activate}
          className={cn(
            bodyText,
            "inline-edit-trigger focus-ring block text-left text-muted-foreground [@media(pointer:coarse)]:min-h-11",
          )}
        >
          {t`Add a description of what this Work is for`}
        </button>
      ) : (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the Show more button below is the keyboard path. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
          <div
            ref={display}
            onClick={() => {
              if (clamped && !window.getSelection()?.toString()) setExpanded(true);
            }}
            className={cn(
              bodyText,
              "overflow-hidden",
              !expanded && clampHeight,
              clamped &&
                "cursor-pointer [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]",
            )}
          >
            {work.goal}
          </div>
          <div className="mt-1 flex max-w-3xl items-center gap-3">
            {clamped ? (
              <button
                type="button"
                className="sr-only focus-visible:not-sr-only focus-visible:text-button focus-visible:text-sm"
                onClick={() => setExpanded(true)}
              >
                <Trans>Show more</Trans>
              </button>
            ) : null}
            {overflows && expanded ? (
              <button
                type="button"
                className="text-button min-h-6 text-sm [@media(pointer:coarse)]:min-h-11"
                onClick={() => setExpanded(false)}
              >
                <Trans>Show less</Trans>
              </button>
            ) : null}
            <button
              type="button"
              ref={bindEditFocus}
              onClick={c.activate}
              className="focus-ring ml-auto min-h-6 rounded-sm text-sm text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11"
            >
              <Trans>Edit</Trans>
            </button>
          </div>
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
      <div className="mt-3 flex max-w-3xl justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={c.saving} onClick={c.cancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button size="sm" disabled={c.saving} onClick={() => void c.save()}>
          {c.saving ? (
            <Trans>Saving…</Trans>
          ) : c.error ? (
            <Trans>Retry save</Trans>
          ) : (
            <Trans>Save</Trans>
          )}
        </Button>
      </div>
    </>
  );
}
