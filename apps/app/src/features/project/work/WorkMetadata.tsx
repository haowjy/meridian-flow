import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkArchived, type UpdateWorkRequest, type Work } from "@meridian/contracts/works";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { announce } from "@/client/announcements";
import { useFailure } from "@/client/failures/useFailure";
import { WorkReturnedError } from "@/client/query/work-mutations";
import { workClosedSentence, workUpdateFailure } from "@/client/query/work-update-failure";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { WorkClosedChip } from "@/components/app/WorkClosedChip";
import { Button } from "@/components/ui/button";
import { InlineEditTextarea } from "@/components/ui/inline-edit";
import { cn } from "@/lib/utils";

type HeldIntent = { run: () => void; cancel: () => void };

export function useWorkMetadataController(
  work: Work,
  saveWork: (data: UpdateWorkRequest) => Promise<unknown>,
) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { failure, fail, end } = useFailure();
  const error = failure?.message ?? null;
  const [closed, setClosed] = useState<string | null>(null);
  const [hasPendingIntent, setHasPendingIntent] = useState(false);
  const heldRef = useRef<HeldIntent>(null);
  const takeHeld = useCallback(() => {
    const intent = heldRef.current;
    heldRef.current = null;
    setHasPendingIntent(false);
    return intent;
  }, []);
  const readOnly = isWorkArchived(work);
  useEffect(
    () => () => {
      heldRef.current?.cancel();
      heldRef.current = null;
    },
    [],
  );
  const displayRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const dirty = editing && draft.trim() !== (work.goal ?? "").trim();
  const focusDisplay = useCallback(
    () => requestAnimationFrame(() => displayRef.current?.focus()),
    [],
  );
  const cancel = useCallback(() => {
    if (!editing) return;
    setEditing(false);
    end("dismissed");
    takeHeld()?.cancel();
    announce(t`Goal edit canceled`);
    focusDisplay();
  }, [editing, focusDisplay, takeHeld, end]);
  const save = useCallback(async (): Promise<boolean> => {
    if (!editing) return true;
    if (!dirty) {
      setEditing(false);
      end("dismissed");
      focusDisplay();
      return true;
    }
    const goal = draft.trim();
    setClosed(null);
    end("retried");
    setEditing(false);
    focusDisplay();
    saveWork({ goal }).then(
      () => announce(t`Goal saved`),
      (cause: unknown) => {
        setDraft(goal);
        setEditing(true);
        if (cause instanceof WorkReturnedError) {
          const sentence = workClosedSentence(cause.why);
          setClosed(sentence);
          announce(sentence);
        } else fail(cause, workUpdateFailure(cause, t`Couldn't save the goal`));
      },
    );
    return true;
  }, [dirty, draft, editing, focusDisplay, saveWork, end, fail]);
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
    if (readOnly) return;
    setEditing(true);
    setDraft(work.goal ?? "");
    setClosed(null);
    end("dismissed");
  }, [readOnly, work.goal, end]);
  const saveAndResume = useCallback(async () => {
    const intent = heldRef.current;
    if (intent && (await save()) && heldRef.current === intent) takeHeld()?.run();
  }, [save, takeHeld]);
  const discardAndResume = useCallback(() => {
    if (!heldRef.current) return;
    setEditing(false);
    end("dismissed");
    takeHeld()?.run();
  }, [takeHeld, end]);
  const keepEditing = useCallback(() => {
    takeHeld()?.cancel();
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [takeHeld]);
  return {
    readOnly,
    editing,
    draft,
    setDraft,
    dirty,
    error,
    closed,
    held: hasPendingIntent,
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

const bodyText = "max-w-3xl whitespace-pre-wrap break-words";
const goalAction =
  "focus-ring min-h-6 rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground coarse:min-h-11";

function goalParagraphs(goal: string): string[] {
  return goal.trim().split(/\n\s*\n/);
}

export function WorkGoal({
  work,
  controller: c,
}: {
  work: Work;
  controller: WorkMetadataController;
}) {
  const { editing, readOnly } = c;
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
  if (readOnly && !editing && !work.goal) return null;
  const hasActions = overflows || !readOnly;
  return (
    <div className="min-w-0 text-body text-foreground">
      {editing ? (
        <GoalEditor controller={c} />
      ) : !work.goal ? (
        <button
          type="button"
          ref={bindEditFocus}
          onClick={c.activate}
          className={cn(
            bodyText,
            "inline-edit-trigger focus-ring block text-left text-muted-foreground coarse:min-h-11",
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
  const closedId = "work-goal-closed";
  return (
    <>
      <InlineEditTextarea
        ref={c.editorRef}
        value={c.draft}
        aria-label={t`Goal`}
        aria-invalid={Boolean(c.error)}
        aria-describedby={c.error ? errorId : c.closed ? closedId : undefined}
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
      {c.error ? <InlineErrorRow id={errorId} message={c.error} className="mt-2 p-0" /> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={c.cancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button size="sm" onClick={() => void c.save()}>
          {c.error ? <Trans>Retry save</Trans> : <Trans>Save</Trans>}
        </Button>
        {c.closed ? <WorkClosedChip id={closedId} sentence={c.closed} /> : null}
      </div>
    </>
  );
}
