/**
 * Extra-usage amount picker — quick-pick chips + a custom USD input, with a
 * single Buy action. The chosen value is the client-side `amountUsd` for the
 * checkout request.
 *
 * Single source of truth: `amount` (string) drives both the input field and
 * the chip pressed-state. A chip is pressed iff its numeric value equals the
 * current amount, so typing a number that matches a preset re-selects it
 * without a parallel "selected chip id" state.
 */
import { Trans } from "@lingui/react/macro";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { equalsUsd, formatPreset, toInputValue, validateAmount } from "./amount";

export interface ExtraUsageAmountOptions {
  minUsd: string;
  maxUsd: string;
  defaultUsd: string;
  presetsUsd: string[];
}

interface ExtraUsagePickerProps {
  amountOptions: ExtraUsageAmountOptions;
  disabled: boolean;
  onPurchase: (amountUsd: string) => void;
}

export function ExtraUsagePicker({ amountOptions, disabled, onPurchase }: ExtraUsagePickerProps) {
  const [amount, setAmount] = useState<string>(() => toInputValue(amountOptions.defaultUsd));
  const inputId = useId();
  const hintId = useId();

  const validation = validateAmount(amount, amountOptions);
  const canPurchase = validation.ok && !disabled;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {amountOptions.presetsUsd.map((preset) => {
          const selected = equalsUsd(preset, amount);
          return (
            <button
              key={preset}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => setAmount(toInputValue(preset))}
              className={cn(
                "focus-ring inline-flex h-8 items-center justify-center rounded-md border px-3 text-sm font-medium tabular-nums transition-colors",
                "disabled:cursor-not-allowed disabled:opacity-50",
                selected
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-card text-muted-foreground hover:border-border-focus hover:bg-surface-subtle hover:text-foreground",
              )}
            >
              {formatPreset(preset)}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5 text-sm">
        <label htmlFor={inputId} className="text-muted-foreground">
          <Trans>Custom amount (USD)</Trans>
        </label>
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground"
          >
            $
          </span>
          <Input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={disabled}
            aria-invalid={!validation.ok && amount.trim() !== ""}
            aria-describedby={hintId}
            className="pl-7 tabular-nums"
            placeholder={toInputValue(amountOptions.defaultUsd)}
          />
        </div>
      </div>

      <Button
        type="button"
        className="w-full"
        disabled={!canPurchase}
        onClick={() => {
          if (validation.ok) onPurchase(validation.amountUsd);
        }}
      >
        <Trans>Buy extra usage</Trans>
      </Button>

      <p
        id={hintId}
        className={cn("text-xs", validation.ok ? "text-muted-foreground" : "text-destructive")}
      >
        {validation.ok ? (
          <Trans>
            Between {formatPreset(amountOptions.minUsd)} and {formatPreset(amountOptions.maxUsd)}.
          </Trans>
        ) : validation.reason === "below-min" ? (
          <Trans>Minimum is {formatPreset(amountOptions.minUsd)}.</Trans>
        ) : validation.reason === "above-max" ? (
          <Trans>Maximum is {formatPreset(amountOptions.maxUsd)}.</Trans>
        ) : (
          <Trans>Enter an amount in USD.</Trans>
        )}
      </p>
    </div>
  );
}
