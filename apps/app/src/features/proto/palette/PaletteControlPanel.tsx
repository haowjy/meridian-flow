/**
 * THROWAWAY floating control panel for /proto/palette.
 *
 * Three preset buttons, eight live token controls (native color picker + raw
 * value text field), a readout, "Copy as CSS", and "Reset to current theme".
 * Everything mutates `:root` style via the parent hook (`use-palette-overrides`).
 * The panel itself paints with hard-coded chrome (border, panel bg) so it
 * stays readable when the user darkens the global border tokens.
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { PALETTE_PRESETS, PALETTE_TOKENS, type PaletteToken, TOKEN_LABELS } from "./presets";
import { readCurrentToken, resolveCssColorToHex } from "./use-palette-overrides";

type Props = {
  values: Partial<Record<PaletteToken, string>>;
  presetId: string | null;
  elevated: boolean;
  onApply: (token: PaletteToken, value: string) => void;
  onApplyPreset: (preset: (typeof PALETTE_PRESETS)[number]) => void;
  onSetElevated: (next: boolean) => void;
  onReset: () => void;
};

export function PaletteControlPanel({
  values,
  presetId,
  elevated,
  onApply,
  onApplyPreset,
  onSetElevated,
  onReset,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Recompute the readout's "currently rendered" cache whenever the applied
  // values change — the hex displayed in the picker swatch should track the
  // var as it actually resolves on :root.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTick((t) => t + 1);
  }, [values, presetId]);

  const handleCopy = async () => {
    const css = PALETTE_TOKENS.map((token) => {
      const value = values[token] ?? readCurrentToken(token).raw;
      return `  ${token}: ${value};`;
    }).join("\n");
    const block = `@theme {\n${css}\n}`;
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Fallback: just log so the user can grab it from devtools if clipboard
      // perms are denied (e.g. http context).

      console.warn("[proto/palette] clipboard blocked, printing CSS:\n", block);
    }
  };

  return (
    <div
      className={cn(
        "fixed bottom-4 right-4 z-40 flex flex-col rounded-xl text-[12px] shadow-2xl",
        "border border-[oklch(0.3_0.01_100/0.18)] bg-[oklch(0.99_0.005_90)] text-[oklch(0.22_0.006_107)]",
      )}
      style={{ width: collapsed ? 200 : 360 }}
      data-testid="palette-control-panel"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[oklch(0.3_0.01_100/0.12)] px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[oklch(0.5_0.01_100)]">
            Throwaway · Ink &amp; Jade
          </span>
          <span className="text-[13px] font-semibold">Palette explorer</span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="rounded-md border border-[oklch(0.3_0.01_100/0.18)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide hover:bg-[oklch(0.95_0.01_90)]"
        >
          {collapsed ? "Expand" : "Collapse"}
        </button>
      </div>

      {collapsed ? null : (
        <div className="flex flex-col gap-3 p-3">
          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[oklch(0.5_0.01_100)]">
              Presets
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              {PALETTE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onApplyPreset(preset)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors",
                    presetId === preset.id
                      ? "border-[oklch(0.536_0.082_175)] bg-[oklch(0.93_0.03_175)] text-[oklch(0.22_0.006_107)]"
                      : "border-[oklch(0.3_0.01_100/0.18)] hover:bg-[oklch(0.95_0.01_90)]",
                  )}
                  title={preset.description}
                >
                  <span className="text-[10px] font-mono uppercase tracking-wide text-[oklch(0.5_0.01_100)]">
                    {preset.letter}
                  </span>
                  <span className="text-[11px] font-semibold leading-tight">{preset.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                checked={elevated}
                onChange={(e) => onSetElevated(e.target.checked)}
                className="size-3.5"
              />
              Elevated manuscript (card + shadow)
            </label>
          </section>

          <section className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[oklch(0.5_0.01_100)]">
              Tokens
            </span>
            <div className="flex flex-col divide-y divide-[oklch(0.3_0.01_100/0.08)]">
              {PALETTE_TOKENS.map((token) => (
                <TokenRow
                  key={token}
                  token={token}
                  appliedValue={values[token]}
                  pickerTick={tick}
                  onApply={onApply}
                />
              ))}
            </div>
          </section>

          <section className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 rounded-md bg-[oklch(0.536_0.082_175)] px-2.5 py-1.5 text-[11px] font-semibold text-[oklch(0.985_0.005_95.1)] hover:opacity-95"
            >
              {copied ? "Copied!" : "Copy as CSS"}
            </button>
            <button
              type="button"
              onClick={onReset}
              className="flex-1 rounded-md border border-[oklch(0.3_0.01_100/0.18)] px-2.5 py-1.5 text-[11px] font-semibold hover:bg-[oklch(0.95_0.01_90)]"
            >
              Reset
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function TokenRow({
  token,
  appliedValue,
  pickerTick,
  onApply,
}: {
  token: PaletteToken;
  appliedValue: string | undefined;
  pickerTick: number;
  onApply: (token: PaletteToken, value: string) => void;
}) {
  const [hex, setHex] = useState<string>("#000000");
  const [raw, setRaw] = useState<string>("");

  useEffect(() => {
    const next = readCurrentToken(token);
    setHex(next.hex);
    setRaw(appliedValue ?? next.raw);
  }, [token, appliedValue, pickerTick]);

  const handlePicker = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setHex(next);
    setRaw(next);
    onApply(token, next);
  };

  const handleRawCommit = () => {
    if (raw.trim().length === 0) {
      onApply(token, "");
      return;
    }
    onApply(token, raw.trim());
    // Sync the picker swatch to the new resolved color.
    const resolved = resolveCssColorToHex(raw.trim());
    if (resolved) setHex(resolved);
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <input
        type="color"
        value={hex}
        onChange={handlePicker}
        className="size-7 cursor-pointer rounded border border-[oklch(0.3_0.01_100/0.18)] bg-transparent p-0.5"
        aria-label={`Pick ${TOKEN_LABELS[token]}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[oklch(0.5_0.01_100)]">
          {TOKEN_LABELS[token]}
        </span>
        <input
          type="text"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onBlur={handleRawCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleRawCommit();
            }
          }}
          spellCheck={false}
          className="w-full truncate bg-transparent font-mono text-[11px] text-[oklch(0.22_0.006_107)] outline-none"
          placeholder="oklch(…) or #hex"
        />
      </div>
    </div>
  );
}
