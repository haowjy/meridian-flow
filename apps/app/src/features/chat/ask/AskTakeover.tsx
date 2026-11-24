import { plural, t } from "@lingui/core/macro";
import type { AskAnswer, QuestionAnswer, ThreadAsk } from "@meridian/contracts/threads";
import type { OpenAsk } from "@meridian/thread-client";
import { ArrowUp } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FailureCard } from "@/components/app/FailureCard";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { permissionRequestText } from "./permission-request";

type QuestionAsk = Extract<ThreadAsk, { kind: "question" }>;
type PermissionAsk = Extract<ThreadAsk, { kind: "permission" }>;

export type QuestionEntry = { choice: QuestionAnswer | null; words: string };

export type QuestionDraft = { step: number; entries: readonly QuestionEntry[] };

export type AskTakeoverProps = {
  open: OpenAsk;
  draft?: QuestionDraft;
  onDraftChange: (draft: QuestionDraft) => void;
  onAnswer: (answer: AskAnswer, sent?: QuestionDraft) => void;
  refused?: boolean;
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

const TYPING_PAUSE_MS = 1000;

function TakeoverFrame({ labelledBy, children }: { labelledBy: string; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = frame.current;
    const box = document.activeElement?.closest<HTMLElement>("[data-composer]");
    if (!box) return focusControls(root);
    let pause = window.setTimeout(take, TYPING_PAUSE_MS);
    function onKey() {
      window.clearTimeout(pause);
      pause = window.setTimeout(take, TYPING_PAUSE_MS);
    }
    function take() {
      stop();
      focusControls(root);
    }
    function stop() {
      window.clearTimeout(pause);
      box?.removeEventListener("keydown", onKey, true);
      box?.removeEventListener("focusout", onLeave);
    }
    function onLeave(event: FocusEvent) {
      if (!box?.contains(event.relatedTarget as Node | null)) stop();
    }
    box.addEventListener("keydown", onKey, true);
    box.addEventListener("focusout", onLeave);
    return stop;
  }, []);
  return (
    <section
      ref={frame}
      aria-labelledby={labelledBy}
      data-ask-takeover=""
      className="flex flex-col gap-[var(--chat-space-block)] rounded-xl border border-border bg-card px-[var(--chat-card-pad-x)] py-[var(--chat-card-pad-y)]"
    >
      {children}
    </section>
  );
}

function focusControls(root: HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body && !active.closest("[data-composer], [data-ask-takeover]"))
    return;
  const target =
    root?.querySelector<HTMLElement>("[aria-pressed=true]") ??
    root?.querySelector<HTMLElement>("[data-ask-place]");
  target?.focus({ preventScroll: true });
}

function ClosedTakeover({ ask }: { ask: ThreadAsk }) {
  const titleId = useId();
  return (
    <TakeoverFrame labelledBy={titleId}>
      <TakeoverTitle id={titleId}>
        {ask.kind === "question"
          ? ask.payload.questions.map((item, index) => (
              // keep: Questions are fixed for the ask's life and answers are positional, so order is identity and key={index} is correct.
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
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    focusControls(optionList.current?.closest<HTMLElement>("[data-ask-takeover]") ?? null);
  }, [step]);
  return (
    <TakeoverFrame labelledBy={titleId}>
      {several ? (
        <div className="-mb-[var(--chat-space-inline)] flex items-baseline gap-[var(--chat-space-block)] px-[var(--chat-space-inline)]">
          <p id={positionId} className="text-xs text-muted-foreground tabular-nums">
            {t`${position} of ${count}`}
          </p>
          {countdown}
        </div>
      ) : null}
      <TakeoverTitle id={titleId}>{question}</TakeoverTitle>
      <fieldset
        ref={optionList}
        data-ask-place=""
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-describedby={several ? positionId : undefined}
        className="flex min-w-0 flex-col gap-[var(--chat-space-inline)] outline-none"
      >
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-pressed={picked === option.label}
            onClick={() => choose({ kind: "option", label: option.label })}
            className="focus-ring interactive flex w-full items-start gap-[var(--chat-space-block)] rounded-lg border border-border-subtle bg-background px-[var(--chat-space-block)] py-[var(--chat-space-inline)] text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-compact font-medium text-foreground">{option.label}</span>
              {option.description ? (
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              ) : null}
            </span>
            {option.label === recommended ? (
              <Chip kind="label" className="mt-0.5">
                {t`Recommended`}
              </Chip>
            ) : null}
          </button>
        ))}
      </fieldset>
      <div
        className={cn(
          "flex items-end gap-[var(--chat-space-inline)] rounded-lg border border-border-subtle bg-background py-1 pl-[var(--chat-space-block)] focus-within:border-focus",
          several ? "pr-[var(--chat-space-block)]" : "pr-1",
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
          <IconButton
            type="button"
            variant="default"
            size="sm"
            className="rounded-lg"
            label={t`Send answer`}
            disabled={entry.choice?.kind !== "text"}
            onClick={forward}
          >
            <ArrowUp />
          </IconButton>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-[var(--chat-space-block)] gap-y-[var(--chat-space-inline)]">
        <Button
          type="button"
          variant="quiet"
          size="sm"
          aria-pressed={entry.choice?.kind === "skipped"}
          className={cn(entry.choice?.kind === "skipped" && "text-foreground")}
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

function Countdown({ deadlineAt }: { deadlineAt: string }) {
  const deadline = Date.parse(deadlineAt);
  const [now, setNow] = useState(() => Date.now());
  const left = Math.max(0, deadline - now);
  useEffect(() => {
    if (left === 0) return;
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
    <p className="ml-auto text-xs text-muted-foreground tabular-nums" data-ask-countdown="">
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
      <fieldset
        aria-labelledby={titleId}
        data-ask-place=""
        tabIndex={-1}
        className="flex min-w-0 flex-wrap items-center gap-[var(--chat-space-inline)] outline-none"
      >
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
      </fieldset>
    </TakeoverFrame>
  );
}
