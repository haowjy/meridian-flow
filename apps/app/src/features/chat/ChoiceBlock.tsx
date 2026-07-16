/**
 * ChoiceBlock — inline ask_user component block for discrete options.
 *
 * Purpose: renders the `kind:"choice"` custom block as a waiting question with
 * option buttons, then as a compact resolved summary after the interrupt
 * lifecycle writes `resolvedValue` + `answerProvenance` into block props.
 * Key decision: the component only emits the component-protocol response value;
 * `CustomBlockRenderer` owns interrupt/thread correlation for the WS message.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { type AskUserChoiceProps, askUserChoiceProps } from "@meridian/contracts/components";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import { ComponentCard, ComponentResolvedSummary } from "./ComponentCard";
import type { ComponentBlockProps } from "./component-registry";

export function ChoiceBlock({ content, respond, isAwaitingResponse }: ComponentBlockProps) {
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
      <ComponentResolvedSummary
        icon={CheckCircle2}
        title={question}
        value={resolvedText ?? t`No answer`}
        statusLabel={
          provenance === "auto" ? <Trans>auto-selected</Trans> : <Trans>you answered</Trans>
        }
      />
    );
  }

  return (
    <ComponentCard
      icon={CheckCircle2}
      tone="pending"
      title={question}
      hint={recommended ? <Trans>Recommended option is highlighted.</Trans> : undefined}
    >
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
                  : "border-border-subtle bg-muted text-foreground hover:border-border-focus hover:bg-sidebar-accent",
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
    </ComponentCard>
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
