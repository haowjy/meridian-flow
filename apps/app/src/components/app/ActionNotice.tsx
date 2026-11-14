import { t } from "@lingui/core/macro";
import { X } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

/**
 * The line a command leaves where it happened: what was done, the way to take it back, and
 * Dismiss ("Deleted Chapter 3 · Undo · ×"). A sentence with a name keeps to one line, the name
 * shortening; one without wraps. An Undo that failed takes the line's place as
 * `InlineErrorRow`, so its message names what failed. The caller owns when it shows, what Undo
 * does and where focus first goes; the caller places the line in its host (`className`).
 */
export function ActionNotice({
  sentence,
  name,
  action,
  onDismiss,
  failure,
  className,
  ...rest
}: {
  /** With `name`, a template for it, so the name's part can shorten and the verb stays whole. */
  sentence: string | ((name: string) => string);
  name?: string | null;
  action?: {
    label: ReactNode;
    onClick: () => void;
    pending?: boolean;
    ref?: Ref<HTMLButtonElement>;
  };
  onDismiss: () => void;
  failure?: Pick<ComponentProps<typeof InlineErrorRow>, "message" | "onRetry" | "onDismiss"> | null;
  className?: string;
} & { [data: `data-${string}`]: string | boolean | undefined }) {
  const line = useRef<HTMLDivElement>(null);
  const holdsFocus = useRef(false);
  const failed = Boolean(failure);
  // A control that unmounts drops focus to the page or a container around the line: switching
  // between the notice and its failure, or a row that stood in while Undo ran. Focus that was on
  // the line, and focus a failure finds dropped, goes to the line's first control (Undo, else
  // Retry, else Dismiss).
  useEffect(() => {
    const element = line.current;
    if (!element) return;
    const enter = () => {
      holdsFocus.current = true;
    };
    // A removed control blurs with no next target: the line still holds focus.
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !element.contains(event.relatedTarget))
        holdsFocus.current = false;
    };
    element.addEventListener("focusin", enter);
    element.addEventListener("focusout", leave);
    return () => {
      element.removeEventListener("focusin", enter);
      element.removeEventListener("focusout", leave);
    };
  }, []);
  useLayoutEffect(() => {
    const element = line.current;
    const active = document.activeElement;
    const dropped = !active || active === document.body || (element && active.contains(element));
    if (!element || !dropped || !(holdsFocus.current || failed)) return;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [failed]);
  return (
    <div
      {...rest}
      ref={line}
      role={failure ? undefined : "status"}
      className={cn(
        "min-w-0 px-2",
        !failure &&
          "flex min-h-7 coarse:min-h-11 items-center gap-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {failure ? (
        <InlineErrorRow {...failure} className="px-0 py-1" />
      ) : (
        <>
          <Sentence sentence={sentence} name={name ?? null} />
          {action ? (
            <button
              ref={action.ref}
              type="button"
              className="text-button shrink-0 text-xs coarse:min-h-11 coarse:min-w-11"
              disabled={action.pending}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ) : null}
          <IconButton label={t`Dismiss`} className="shrink-0" onClick={onDismiss}>
            <X aria-hidden />
          </IconButton>
        </>
      )}
    </div>
  );
}

// Stands in for the name while splitting the template, so a name that also occurs in the
// sentence's own words ("Del" in "Deleted Del") can't be cut in the wrong place.
const NAME_SLOT = "\u0000";

function Sentence({
  sentence,
  name,
}: {
  sentence: string | ((name: string) => string);
  name: string | null;
}) {
  const text = typeof sentence === "string" ? sentence : sentence(name ?? "");
  const parts = typeof sentence === "string" || !name ? null : sentence(NAME_SLOT).split(NAME_SLOT);
  // With no name to shorten, the sentence wraps: what it says is never only in a hover title.
  if (parts?.length !== 2) return <span className="min-w-0 flex-1 text-pretty">{text}</span>;
  return (
    <span className="flex min-w-0 flex-1 whitespace-pre" title={text}>
      <span className="shrink-0">{parts[0]}</span>
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0">{parts[1]}</span>
    </span>
  );
}
