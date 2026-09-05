/** DOM-input observation transport for a host-neutral suggestion driver. */
import type { SuggestionDriver, SuggestionTriggerRange } from "./suggestion-driver";
import type {
  SuggestionHost,
  SuggestionHostLease,
  SuggestionKeyBindings,
  SuggestionMenu,
} from "./suggestion-menu-store";

export type DomInputSelection = Readonly<{
  from: number;
  to: number;
  direction: "forward" | "backward" | "none";
}>;
export type DomInputSuggestionTransportOptions<TRow, TMeta = null> = Readonly<{
  input: HTMLInputElement;
  driver: SuggestionDriver<never, TRow, TMeta>;
  suggestionHost: SuggestionHost;
  hostLeaseId: string;
  match: (
    input: Readonly<{ value: string; selection: DomInputSelection }>,
  ) => Readonly<{ query: string; text: string; triggerRange: SuggestionTriggerRange }> | null;
  keyBindings?: (menu: SuggestionMenu<TRow, TMeta>) => SuggestionKeyBindings;
}>;
export type DomInputSuggestionTransport = Readonly<{ sync: () => void; destroy: () => void }>;

type Envelope = { value: string; selection: DomInputSelection; range: SuggestionTriggerRange };
export function createDomInputSuggestionTransport<TRow, TMeta = null>(
  options: DomInputSuggestionTransportOptions<TRow, TMeta>,
): DomInputSuggestionTransport {
  const { input, driver } = options;
  let active = false;
  let composing = false;
  let destroyed = false;
  let lease: SuggestionHostLease | null = null;
  let dismissed: Envelope | null = null;
  const releaseLease = () => {
    lease?.release();
    lease = null;
  };
  const exit = () => {
    releaseLease();
    if (active) driver.exit();
    active = false;
  };
  const selection = (): DomInputSelection | null =>
    input.selectionStart === null || input.selectionEnd === null
      ? null
      : {
          from: input.selectionStart,
          to: input.selectionEnd,
          direction: input.selectionDirection ?? "none",
        };
  const sameEnvelope = (
    left: Envelope,
    value: string,
    selected: DomInputSelection,
    range: SuggestionTriggerRange,
  ) =>
    left.value === value &&
    left.selection.from === selected.from &&
    left.selection.to === selected.to &&
    left.selection.direction === selected.direction &&
    left.range.from === range.from &&
    left.range.to === range.to;
  const requestExit = () => {
    const selected = selection();
    const matched = selected && options.match({ value: input.value, selection: selected });
    if (selected && matched)
      dismissed = { value: input.value, selection: selected, range: matched.triggerRange };
    exit();
  };
  const sync = () => {
    if (destroyed || composing || !input.isConnected || document.activeElement !== input)
      return exit();
    const selected = selection();
    if (!selected) return exit();
    const matched = options.match({ value: input.value, selection: selected });
    if (!matched) return exit();
    if (dismissed && sameEnvelope(dismissed, input.value, selected, matched.triggerRange))
      return exit();
    dismissed = null;
    const frame = {
      ...matched,
      candidates: [] as never[],
      loading: false,
      anchorRect: () => inputCaretRect(input),
      requestExit,
    };
    if (active) driver.update(frame);
    else {
      active = true;
      driver.start(frame);
    }
  };
  const updateLease = () => {
    if (!driver.menu.snapshot().open) return releaseLease();
    if (lease) return;
    lease = options.suggestionHost.register({
      id: options.hostLeaseId,
      bindings: options.keyBindings?.(driver.menu) ?? {
        ArrowDown: () => driver.menu.move(1),
        ArrowUp: () => driver.menu.move(-1),
        Home: () => driver.menu.moveTo("first"),
        End: () => driver.menu.moveTo("last"),
        Enter: () => driver.menu.chooseActive("enter"),
        Tab: () => driver.menu.chooseActive("tab"),
      },
      retreat: { backtrack: () => driver.menu.backtrack(), dismiss: () => driver.menu.dismiss() },
    });
  };
  const unsubscribe = driver.menu.subscribe(updateLease);
  const observe = () => sync();
  const blur = () => exit();
  const compositionStart = () => {
    composing = true;
    exit();
  };
  const compositionEnd = () => {
    composing = false;
    sync();
  };
  input.addEventListener("focus", observe);
  input.addEventListener("blur", blur);
  input.addEventListener("input", observe);
  input.addEventListener("select", observe);
  input.addEventListener("compositionstart", compositionStart);
  input.addEventListener("compositionend", compositionEnd);
  return {
    sync,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      input.removeEventListener("focus", observe);
      input.removeEventListener("blur", blur);
      input.removeEventListener("input", observe);
      input.removeEventListener("select", observe);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionend", compositionEnd);
      unsubscribe();
      exit();
    },
  };
}

function inputCaretRect(input: HTMLInputElement): DOMRect | null {
  if (!input.isConnected || input.selectionStart === null) return null;
  const style = getComputedStyle(input);
  const inputRect = input.getBoundingClientRect();
  const mirror = document.createElement("div");
  const probe = document.createElement("span");
  mirror.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;white-space:pre;overflow:hidden;box-sizing:${style.boxSizing};left:${inputRect.left}px;top:${inputRect.top}px;width:${inputRect.width}px;height:${inputRect.height}px;font:${style.font};letter-spacing:${style.letterSpacing};padding:${style.padding};border:${style.border};direction:${style.direction};text-align:${style.textAlign}`;
  mirror.textContent = input.value.slice(0, input.selectionStart);
  probe.textContent = "\u200b";
  mirror.append(probe);
  document.body.append(mirror);
  const rect = probe.getBoundingClientRect();
  mirror.remove();
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const borderRight = Number.parseFloat(style.borderRightWidth) || 0;
  const left = Math.min(
    inputRect.right - borderRight,
    Math.max(inputRect.left + borderLeft, rect.left - input.scrollLeft),
  );
  const top = Math.min(inputRect.bottom, Math.max(inputRect.top, rect.top));
  return new DOMRect(left, top, 0, Math.min(rect.height, inputRect.bottom - top));
}
