/**
 * The folder and file list under `IdentityPlacementField`'s name field. The
 * host owns the popover and the input; this list is a `Picker` whose Escape
 * calls `onClose`. A host `header` (e.g. a validation note) renders inside the
 * picker: any focusable it marks with `data-list-item` joins the arrow-key
 * walk in visual order.
 */

import { t } from "@lingui/core/macro";
import { Folder } from "lucide-react";
import { forwardRef, type ReactNode, useImperativeHandle, useRef } from "react";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerResults, PickerSection } from "@/components/ui/picker";
import { fileKindIcon } from "../context-file-icon";
import { schemeIcon, schemeLabel, schemeLocation } from "../context-schemes";
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
    emptyMessage: string;
    /** Rendered above the rows, inside the picker's keyboard walk. */
    header?: ReactNode;
  }
>(function FileSuggestionList(
  { suggestions, onSelect, onClose, onNavigateUp, hideParents = false, emptyMessage, header },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusStops = () =>
    Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-list-item]") ?? []);
  useImperativeHandle(ref, () => ({
    focusFirst: () => focusStops()[0]?.focus(),
    focusLast: () => focusStops().at(-1)?.focus(),
  }));

  return (
    <Picker ref={rootRef} label={t`File suggestions`} onEscape={onClose}>
      {header}
      <PickerResults>
        <PickerSection>
          {onNavigateUp ? (
            <li>
              <ListRow
                density="menu"
                icon={Folder}
                title={<span className="text-muted-foreground">..</span>}
                controlProps={{ "aria-label": t`Enclosing folder` }}
                onOpen={onNavigateUp}
              />
            </li>
          ) : null}
          {suggestions.map((suggestion) => {
            const root = suggestion.path === "/";
            return (
              <li key={suggestion.entryId}>
                <ListRow
                  density="menu"
                  // Scheme roots are contexts, not folders: they carry their
                  // identity icon (same mapping the tree panel uses).
                  icon={
                    root
                      ? schemeIcon(suggestion.scheme)
                      : suggestion.kind === "dir"
                        ? Folder
                        : fileKindIcon(suggestion.name)
                  }
                  title={root ? schemeLabel(suggestion.scheme) : suggestion.name}
                  meta={
                    suggestion.hint ??
                    (hideParents || root
                      ? undefined
                      : schemeLocation(suggestion.scheme, suggestion.parents) || undefined)
                  }
                  onOpen={() => onSelect(suggestion)}
                />
              </li>
            );
          })}
        </PickerSection>
        {suggestions.length === 0 ? (
          <ListLine density="menu" iconSlot>
            {emptyMessage}
          </ListLine>
        ) : null}
      </PickerResults>
    </Picker>
  );
});
