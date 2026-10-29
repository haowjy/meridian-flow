/**
 * The composer takeover for an open ask: its questions (options, own words, Skip, the deadline,
 * and for several, a step at a time with Back) or a permission request (Deny, Allow always,
 * Allow). Both draw in one frame, in the box's place, so the writer learns it once; only the
 * controls differ.
 */
import { plural, t } from "@lingui/core/macro";
import type { AskAnswer, QuestionAnswer, ThreadAsk } from "@meridian/contracts/threads";
import type { OpenAsk } from "@meridian/thread-client";
import { ArrowUp } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { permissionRequestText } from "./permission-request";

type QuestionAsk = Extract<ThreadAsk, { kind: "question" }>;
type PermissionAsk = Extract<ThreadAsk, { kind: "permission" }>;

/** One question's place in the writer's draft: their choice, and what's in its own-words field. */
export type QuestionEntry = { choice: QuestionAnswer | null; words: string };

/** Where the writer is in a question ask. The host holds it, so it outlives the takeover. */
export type QuestionDraft = { step: number; entries: readonly QuestionEntry[] };

export type AskTakeoverProps = {
  open: OpenAsk;
  /** For a question ask; a permission request has none. */
  draft?: QuestionDraft;
  onDraftChange: (draft: QuestionDraft) => void;
  /** A question's answer comes with the draft it was sent from, for the host to hold. */
  onAnswer: (answer: AskAnswer, sent?: QuestionDraft) => void;
  /** The server refused the last answer; the draft is already at the question it named, if any. */
  refused?: boolean;
  /** Read the chat again: the server closed the ask without saying how. */
  onSettle: () => void;
};

export function AskTakeover({
  open,
  draft,
  onDraftChange,
  onAnswer,
  refused,
  onSettle,
}: AskTakeoverProps) {
  const { ask, attempt } = open;
  if (attempt?.state === "unsettled") {
    // The ask is closed; only how it ended is unknown. Nothing here may answer it again.
    return (
      <>
        <div className="mb-[var(--chat-space-inline)]">
          <FailureCard tone="error">
            <p className="min-w-0 flex-1">{t`Couldn't check how this question ended.`}</p>
            <Button type="button" size="xs" variant="outline" onClick={onSettle}>
              {t`Refresh`}
            </Button>
          </FailureCard>
        </div>
        <ClosedTakeover ask={ask} />
      </>
    );
  }
  const failed = attempt?.state === "failed" ? attempt : null;
  const failure = failed ? (
    <FailureCard tone="error">
      <p className="min-w-0 flex-1">{t`Couldn't send your answer.`}</p>
      <Button type="button" size="xs" variant="outline" onClick={() => onAnswer(failed.answer)}>
        {t`Retry`}
      </Button>
    </FailureCard>
  ) : null;
  return (
    <>
      {failure ? <div className="mb-[var(--chat-space-inline)]">{failure}</div> : null}
      {refused ? (
        <div className="mb-[var(--chat-space-inline)]">
          <FailureCard tone="error">
            <p className="min-w-0 flex-1">{t`This answer couldn't be used. Choose again.`}</p>
          </FailureCard>
        </div>
      ) : null}
      {ask.kind === "permission" ? (
        <PermissionTakeover ask={ask} onAnswer={onAnswer} />
      ) : draft ? (
        <QuestionTakeover
          key={ask.id}
          ask={ask}
          draft={draft}
          onDraftChange={onDraftChange}
          onAnswer={onAnswer}
        />
      ) : null}
    </>
  );
}

function TakeoverFrame({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  // The box this replaces may have held focus; hiding it would drop focus on the page.
  useEffect(() => focusControls(frame.current), []);
  return (
    <section
      ref={frame}
      aria-labelledby={labelledBy}
      data-ask-takeover=""
      className="flex flex-col gap-[var(--chat-space-block)] rounded-composer-pinned border border-composer-border bg-composer-surface px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
    >
      {children}
    </section>
  );
}

/**
 * Focus the answer the writer holds, else the first control, unless they are working elsewhere on
 * the page (another tab's answer moves a takeover nobody is using). Never the field: on a phone
 * that would raise the keyboard each time the controls change.
 */
function focusControls(root: HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest("[data-composer], [data-ask-takeover]"))
    return;
  const target =
    root?.querySelector<HTMLElement>("[aria-pressed=true]") ??
    root?.querySelector<HTMLElement>("button");
  target?.focus({ preventScroll: true });
}

/** The ask's title alone: it can no longer be answered here. */
function ClosedTakeover({ ask }: { ask: ThreadAsk }) {
  const titleId = useId();
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>
        {ask.kind === "question"
          ? ask.payload.questions.map((item, index) => (
              // Questions are fixed for the ask's life; their order is their identity.
              <span key={index} className="block">
                {item.question}
              </span>
            ))
          : permissionRequestText(ask.payload).title}
      </TakeoverTitle>
    </TakeoverFrame>
  );
}

function TakeoverTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="px-[var(--chat-space-inline)] text-body font-medium text-pretty">
      {children}
    </h2>
  );
}

/**
 * The questions one at a time. One question answers in one action, as a single question always
 * has; several step forward on each choice, with Back to revise, and the last sends the set.
 */
function QuestionTakeover({
  ask,
  draft,
  onDraftChange,
  onAnswer,
}: {
  ask: QuestionAsk;
  draft: QuestionDraft;
  onDraftChange: (draft: QuestionDraft) => void;
  onAnswer: (answer: AskAnswer, sent?: QuestionDraft) => void;
}) {
  const titleId = useId();
  const positionId = useId();
  const { questions } = ask.payload;
  const { step, entries } = draft;
  const { question, options, recommended } = questions[step];
  const entry = entries[step];
  const count = questions.length;
  const position = step + 1;
  const several = count > 1;
  const last = position === count;
  const choices = entries.map((held) => held.choice);
  const complete = choices.every((choice) => choice !== null);
  const send = (held: readonly QuestionEntry[]) =>
    onAnswer(
      { kind: "answers", answers: held.map((item) => item.choice as QuestionAnswer) },
      { step, entries: held },
    );
  // Words stay in the field when an option is picked: they go back to the composer if unused.
  const choose = (choice: QuestionAnswer) => {
    const next = entries.map((held, index) => (index === step ? { ...held, choice } : held));
    if (!several) return send(next);
    onDraftChange({ step: last ? step : step + 1, entries: next });
  };
  const type = (words: string) => {
    const typed = words.trim();
    const choice: QuestionAnswer | null = typed
      ? { kind: "text", text: typed }
      : entry.choice?.kind === "text"
        ? null
        : entry.choice;
    onDraftChange({
      step,
      entries: entries.map((held, index) => (index === step ? { choice, words } : held)),
    });
  };
  const forward = () => {
    if (entry.choice === null) return;
    if (!several || last) {
      if (complete) send(entries);
    } else onDraftChange({ step: step + 1, entries });
  };
  const picked = entry.choice?.kind === "option" ? entry.choice.label : null;
  const countdown = ask.deadlineAt ? <Countdown deadlineAt={ask.deadlineAt} /> : null;
  const optionList = useRef<HTMLFieldSetElement>(null);
  const shownStep = useRef(step);
  // A step replaces the controls under the writer's hand; their place is the new question's options.
  // Compared with the step last shown, not a first-run flag, so a remount or a repeated effect
  // moves nothing.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    focusControls(optionList.current);
  }, [step]);
  return (
    <TakeoverFrame labelledBy={titleId}>
      {several ? (
        <div className="-mb-[var(--chat-space-inline)] flex items-baseline gap-[var(--chat-space-block)] px-[var(--chat-space-inline)]">
          <p id={positionId} className="text-caption text-muted-foreground tabular-nums">
            {t`${position} of ${count}`}
          </p>
          {countdown}
        </div>
      ) : null}
      <TakeoverTitle id={titleId}>{question}</TakeoverTitle>
      <fieldset
        ref={optionList}
        aria-labelledby={titleId}
        aria-describedby={several ? positionId : undefined}
        className="flex min-w-0 flex-col gap-[var(--chat-space-inline)]"
      >
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={picked === option.label}
            onClick={() => choose({ kind: "option", label: option.label })}
            className={cn(
              "focus-ring flex w-full items-start gap-[var(--chat-space-block)] rounded-field border border-border-subtle bg-background px-[var(--chat-space-block)] py-[var(--chat-space-inline)] text-left transition-colors hover:border-border-focus hover:bg-accent",
              picked === option.label && "border-border-focus bg-accent",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-compact font-medium text-foreground">{option.label}</span>
              {option.description ? (
                <span className="block text-caption text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </span>
            {option.label === recommended ? (
              <Badge variant="label" className="mt-0.5">
                {t`Recommended`}
              </Badge>
            ) : null}
          </button>
        ))}
      </fieldset>
      <div
        className={cn(
          "flex items-end gap-[var(--chat-space-inline)] rounded-field border border-border-subtle bg-background py-1 pl-[var(--chat-space-block)] focus-within:border-border-focus",
          several ? "pr-[var(--chat-space-block)]" : "pr-1",
          entry.choice?.kind === "text" && "border-border-focus",
        )}
      >
        <textarea
          aria-label={t`Your own answer`}
          placeholder={t`Or type your own answer`}
          rows={1}
          value={entry.words}
          onChange={(event) => type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (entry.choice?.kind === "text") forward();
          }}
          className="field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-compact outline-none placeholder:text-muted-foreground"
        />
        {several ? null : (
          <Button
            type="button"
            size="icon-sm"
            className="rounded-field"
            aria-label={t`Send answer`}
            disabled={entry.choice?.kind !== "text"}
            onClick={forward}
          >
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)]">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          aria-pressed={entry.choice?.kind === "skipped"}
          className={cn(
            "border border-transparent",
            entry.choice?.kind === "skipped" && "border-border-focus bg-accent text-foreground",
          )}
          onClick={() => choose({ kind: "skipped" })}
        >
          {t`Skip`}
        </Button>
        {several ? null : countdown}
        {several ? (
          <div className="ml-auto flex items-center gap-[var(--chat-space-inline)]">
            {step > 0 ? (
              <Button
                type="button"
                variant="quiet"
                size="sm"
                onClick={() => onDraftChange({ step: step - 1, entries })}
              >
                {t`Back`}
              </Button>
            ) : null}
            {last ? (
              <Button type="button" size="sm" disabled={!complete} onClick={forward}>
                {t`Send answers`}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={entry.choice === null}
                onClick={forward}
              >
                {t`Next`}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </TakeoverFrame>
  );
}

/** Time left before the question continues on its own; "Continuing…" at zero, until the server says how. */
function Countdown({ deadlineAt }: { deadlineAt: string }) {
  const deadline = Date.parse(deadlineAt);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, deadline - now);
  useEffect(() => {
    if (left === 0) return;
    // Wake on the next whole second of the countdown, so the label never runs a second behind.
    const timer = setTimeout(() => setNow(Date.now()), left % 1000 || 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const seconds = Math.ceil(left / 1000);
  const label =
    seconds === 0
      ? t`Continuing…`
      : seconds >= 60
        ? plural(Math.floor(seconds / 60), {
            one: "Continues in # min",
            other: "Continues in # min",
          })
        : plural(seconds, { one: "Continues in # second", other: "Continues in # seconds" });
  return (
    <p className="ml-auto text-caption text-muted-foreground tabular-nums" data-ask-countdown="">
      {label}
    </p>
  );
}

function PermissionTakeover({
  ask,
  onAnswer,
}: {
  ask: PermissionAsk;
  onAnswer: (answer: AskAnswer) => void;
}) {
  const titleId = useId();
  const { title, details } = permissionRequestText(ask.payload);
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>{title}</TakeoverTitle>
      {details.length > 0 ? (
        <ul className="flex flex-col px-[var(--chat-space-inline)] text-compact text-muted-foreground">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-[var(--chat-space-inline)]">
        <Button type="button" variant="quiet" size="sm" onClick={() => onAnswer({ kind: "deny" })}>
          {t`Deny`}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => onAnswer({ kind: "allow_always" })}
        >
          {t`Allow always`}
        </Button>
        <Button type="button" size="sm" onClick={() => onAnswer({ kind: "allow" })}>
          {t`Allow`}
        </Button>
      </div>
    </TakeoverFrame>
  );
}
