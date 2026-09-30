/**
 * Page-scoped Work goal editing lifecycle. The name is renamed in the band's
 * title tab; this owns the goal, which never saves on blur and so guards
 * navigation while a draft is dirty.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { UpdateWorkRequest, Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { Button } from "@/components/ui/button";
import { InlineEditTextarea } from "@/components/ui/inline-edit";
import { cn } from "@/lib/utils";

type HeldIntent = { run: () => void; cancel: () => void };

/**
 * What the writer reads when a goal save fails. Only a refusal the writer can
 * act on gets its own line; a network drop or anything else is a plain retry.
 */
function goalSaveFailure(cause: unknown): string {
  const status =
    cause instanceof HttpResponseError || isMeridianApiError(cause) ? cause.status : undefined;
  if (status === 409) return t`This Work is archived.`;
  if (status === 404 || status === 410) return t`This Work no longer exists.`;
  return t`Couldn’t save the goal. Try again.`;
}

export function useWorkMetadataController(
  work: Work,
  saveWork: (data: UpdateWorkRequest) => Promise<unknown>,
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
    setAnnouncement(t`Goal edit canceled`);
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
      setAnnouncement(t`Goal saved`);
      focusDisplay();
      return true;
    } catch (cause) {
      setError(goalSaveFailure(cause));
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
// Quiet text actions that sit under the goal and read as part of it.
const goalAction =
  "focus-ring min-h-6 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground [@media(pointer:coarse)]:min-h-11";

/** Blank-line runs become paragraph breaks, so a clamp never ends on a blank line. */
function goalParagraphs(goal: string): string[] {
  return goal.trim().split(/\n\s*\n/);
}

/**
 * The Work goal: body text clamped to three lines. Show more (or clicking a
 * clamped goal) shows all of it; Show less folds it again. Edit goal (or
 * clicking an empty goal) edits in place: the field takes the text's exact
 * position and size. Cancel then Save sit left-aligned under the field, so
 * Cancel lands where Edit goal was; blur never saves. The goal's actions sit
 * directly under the text; a read-only goal has no Edit goal, and an empty one
 * shows nothing.
 */
export function WorkGoal({
  work,
  controller: c,
  readOnly = false,
}: {
  work: Work;
  controller: WorkMetadataController;
  readOnly?: boolean;
}) {
  const editing = c.editing && !readOnly;
  const display = useRef<HTMLDivElement | null>(null);
  const goalId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // An expanded goal can't be measured for clamping, so new text starts
  // folded and is measured afresh: a short one then drops Show less.
  const [shownGoal, setShownGoal] = useState(work.goal);
  if (shownGoal !== work.goal) {
    setShownGoal(work.goal);
    setExpanded(false);
  }
  useLayoutEffect(() => {
    if (!editing) return;
    const editor = c.editorRef.current;
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
  }, [editing, c.editorRef]);
  useEffect(() => {
    const node = display.current;
    if (editing || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!expanded) setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    if (expanded) setOverflows(true);
    else measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [editing, work.goal, expanded]);
  const clamped = overflows && !expanded;
  const bindEditFocus = (node: HTMLButtonElement | null) => {
    c.displayRef.current = node;
  };
  // Nothing to show or edit: no empty box to space the header around.
  if (readOnly && !work.goal) return null;
  const hasActions = overflows || !readOnly;
  return (
    <div className="min-w-0 text-body text-foreground">
      <p className="sr-only" aria-live="polite">
        {c.announcement}
      </p>
      {editing ? (
        <GoalEditor controller={c} />
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
          {t`Add a goal for this Work`}
        </button>
      ) : (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; the Show more button below is the keyboard path. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
          <div
            ref={display}
            id={goalId}
            onClick={() => {
              if (clamped && !window.getSelection()?.toString()) setExpanded(true);
            }}
            className={cn(
              "max-w-3xl break-words [&>p+p]:mt-3",
              !expanded && "line-clamp-3",
              clamped && "cursor-pointer",
            )}
          >
            {goalParagraphs(work.goal).map((paragraph, index) => (
              <p key={index} className="whitespace-pre-wrap">
                {paragraph}
              </p>
            ))}
          </div>
          {hasActions ? (
            <div className="mt-1 flex items-center gap-4">
              {overflows ? (
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={goalId}
                  className={goalAction}
                  onClick={() => setExpanded((open) => !open)}
                >
                  {expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
                </button>
              ) : null}
              {readOnly ? null : (
                <button
                  type="button"
                  ref={bindEditFocus}
                  onClick={c.activate}
                  className={goalAction}
                >
                  <Trans>Edit goal</Trans>
                </button>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function GoalEditor({ controller: c }: { controller: WorkMetadataController }) {
  const errorId = "work-goal-error";
  return (
    <>
      <InlineEditTextarea
        ref={c.editorRef}
        value={c.draft}
        disabled={c.saving}
        aria-label={t`Goal`}
        aria-invalid={Boolean(c.error)}
        aria-describedby={c.error ? errorId : undefined}
        placeholder={t`Add a goal for this Work`}
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
      <div className="mt-3 flex items-center gap-2">
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
