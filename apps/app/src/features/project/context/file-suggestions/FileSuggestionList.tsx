/**
 * Reusable suggestion list for save destinations, composer attachments, and
 * future quick-open hosts. Hosts own the popover/input; this component owns
 * rows, roving keyboard focus, selection, and dismissal. A host `header`
 * (e.g. a validation note) renders inside the roving boundary: any focusable
 * it marks with `data-file-suggestion` joins the arrow-key walk in visual
 * order, so keyboard users can reach its actions.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Folder } from "lucide-react";
import { forwardRef, type KeyboardEvent, type ReactNode, useImperativeHandle, useRef } from "react";
import { fileKindIcon } from "../context-file-icon";
import { schemeIcon, schemeLabel } from "../context-schemes";
import type { FileSuggestion } from "./file-suggestions";

/** A row with an optional right-edge annotation (e.g. "new folder"). */
export type AnnotatedFileSuggestion = FileSuggestion & { hint?: string };

export type FileSuggestionListHandle = {
  focusFirst(): void;
  focusLast(): void;
};

export const FileSuggestionList = forwardRef<
  FileSuggestionListHandle,
  {
    suggestions: readonly AnnotatedFileSuggestion[];
    onSelect: (suggestion: FileSuggestion) => void;
    onClose: () => void;
    /** When set, a leading `..` row navigates to the enclosing level. */
    onNavigateUp?: () => void;
    /** Browse mode: rows share one folder, so per-row parent labels are noise. */
    hideParents?: boolean;
    emptyMessage?: string;
    /** Rendered above the rows, inside the roving-focus boundary. */
    header?: ReactNode;
  }
>(function FileSuggestionList(
  { suggestions, onSelect, onClose, onNavigateUp, hideParents = false, emptyMessage, header },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusStops = () =>
    Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-suggestion]") ?? [],
    );
  useImperativeHandle(ref, () => ({
    focusFirst: () => focusStops()[0]?.focus(),
    focusLast: () => focusStops().at(-1)?.focus(),
  }));
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
    const rows = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-file-suggestion]"),
    );
    if (rows.length === 0) return;
    const currentIndex = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Enter") {
      if (currentIndex >= 0) {
        event.preventDefault();
        rows[currentIndex]?.click();
      }
      return;
    }
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? (currentIndex + 1) % rows.length
            : (currentIndex <= 0 ? rows.length : currentIndex) - 1;
    event.preventDefault();
    rows[nextIndex]?.focus();
  };

  const rowClass =
    "focus-ring flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-sidebar-accent focus:bg-sidebar-accent";

  return (
    // The keydown boundary wraps header + rows so one arrow walk covers both;
    // the listbox role stays on the rows alone (the header is not an option).
    // biome-ignore lint/a11y/noStaticElementInteractions: keydown-only composite boundary — the focusables inside carry the interactive roles, and no ARIA role fits a note+listbox composite.
    <div ref={rootRef} onKeyDown={handleKeyDown}>
      {header}
      <div role="listbox" aria-label={t`File suggestions`}>
        <ul className="flex flex-col gap-0.5 p-1">
          {onNavigateUp ? (
            <li>
              <button
                data-file-suggestion
                type="button"
                role="option"
                tabIndex={-1}
                aria-label={t`Enclosing folder`}
                onClick={onNavigateUp}
                className={rowClass}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-muted-foreground">..</span>
              </button>
            </li>
          ) : null}
          {suggestions.length === 0 ? (
            <li>
              <p className="px-2.5 py-3 text-center text-muted-foreground text-xs">
                {emptyMessage ?? <Trans>No matching files</Trans>}
              </p>
            </li>
          ) : (
            suggestions.map((suggestion) => {
              // Scheme roots are contexts, not folders — they carry their
              // identity icon (same mapping the tree panel uses).
              const Icon =
                suggestion.path === "/"
                  ? schemeIcon(suggestion.scheme)
                  : suggestion.kind === "dir"
                    ? Folder
                    : fileKindIcon(suggestion.name);
              const displayName =
                suggestion.path === "/" ? schemeLabel(suggestion.scheme) : suggestion.name;
              const parent = suggestion.hint
                ? suggestion.hint
                : hideParents
                  ? ""
                  : suggestion.parents.length
                    ? `${schemeLabel(suggestion.scheme)} / ${suggestion.parents.join(" / ")}`
                    : suggestion.path === "/"
                      ? ""
                      : schemeLabel(suggestion.scheme);
              return (
                <li key={`${suggestion.scheme}:${suggestion.path}`}>
                  <button
                    data-file-suggestion
                    type="button"
                    role="option"
                    tabIndex={-1}
                    onClick={() => onSelect(suggestion)}
                    className={rowClass}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate">{displayName}</span>
                    {parent ? (
                      <span className="ml-auto min-w-0 truncate text-meta text-muted-foreground">
                        {parent}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
});
