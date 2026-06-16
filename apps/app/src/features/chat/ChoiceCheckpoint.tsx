/**
 * ChoiceCheckpoint — inline ask_user checkpoint for discrete options.
 *
 * Purpose: renders the `kind:"choice"` custom block as a waiting question with
 * option buttons, then as a compact resolved summary after the checkpoint
 * lifecycle writes `resolvedValue` + `answerProvenance` into block props.
 * Key decision: the component only emits the component-protocol response value;
 * `CustomBlockRenderer` owns checkpoint/thread correlation for the WS message.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type AskUserChoiceProps, askUserChoiceProps } from "@meridian/contracts/components";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { ComponentBlockProps } from "./component-registry";

export function ChoiceCheckpoint({ content, respond, isAwaitingResponse }: ComponentBlockProps) {
  const props = askUserChoiceProps(content);
  const question = props?.question ?? t`Choose an option`;
  const options = props?.options ?? [];
  const recommended = props?.recommended ?? null;
  const hasResolvedValue = props?.resolvedValue !== undefined;
  const resolvedValue = props?.resolvedValue;
  const resolvedText = hasResolvedValue
    ? (displayChoiceValue(resolvedValue, options) ?? t`No answer`)
    : null;
  const provenance = props?.answerProvenance ?? null;
  const [submittedValue, setSubmittedValue] = useState<string | null>(null);

  if (!isAwaitingResponse && hasResolvedValue) {
    return (
      <ResolvedCheckpointSummary
        question={question}
        answer={resolvedText ?? t`No answer`}
        provenance={provenance}
      />
    );
  }

  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-card p-3 shadow-xs">
      <div className="mb-3 flex items-start gap-2">
        <div className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-surface-subtle text-primary">
          <CheckCircle2 className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{question}</p>
          {recommended ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>Recommended option is highlighted.</Trans>
            </p>
          ) : null}
        </div>
      </div>

      <fieldset className="flex flex-wrap gap-2">
        <legend className="visually-hidden">{question}</legend>
        {options.map((option) => {
          const isRecommended = option.value === recommended;
          const isSubmitted = submittedValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={!isAwaitingResponse || submittedValue !== null}
              onClick={() => {
                setSubmittedValue(option.value);
                respond({ value: option.value });
              }}
              className={cn(
                "focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60",
                isRecommended
                  ? "border-primary bg-primary text-primary-foreground shadow-button"
                  : "border-border-subtle bg-surface-subtle text-foreground hover:border-border-focus hover:bg-sidebar-accent",
              )}
              aria-describedby={isRecommended ? `${option.value}-recommended` : undefined}
            >
              <span>{option.label}</span>
              {isRecommended ? (
                <span id={`${option.value}-recommended`} className="text-xs opacity-80">
                  <Trans>Recommended</Trans>
                </span>
              ) : null}
              {isSubmitted ? <span className="text-xs opacity-80">✓</span> : null}
            </button>
          );
        })}
      </fieldset>
    </section>
  );
}

function ResolvedCheckpointSummary({
  question,
  answer,
  provenance,
}: {
  question: string;
  answer: string;
  provenance: "user" | "auto" | null;
}) {
  return (
    <section className="mb-4 rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2">
      <p className="text-xs text-muted-foreground">{question}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-foreground">
        <span className="font-medium">{answer}</span>
        <span className="status-pill">
          {provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>}
        </span>
      </div>
    </section>
  );
}

function displayChoiceValue(
  value: string | undefined,
  options: AskUserChoiceProps["options"],
): string | null {
  const text = value && value.length > 0 ? value : null;
  if (!text) return null;
  return options.find((option) => option.value === text)?.label ?? text;
}
