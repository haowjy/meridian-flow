import { t } from "@lingui/core/macro";
import { Folder } from "lucide-react";
import { forwardRef, type ReactNode, useImperativeHandle, useRef } from "react";
import { ListLine, ListRow } from "@/components/ui/list-row";
import { Picker, PickerResults, PickerSection } from "@/components/ui/picker";
import { fileKindIcon } from "../context-file-icon";
import { schemeIcon, schemeLabel, schemeLocation } from "../context-schemes";
import type { FileSuggestion } from "./file-suggestions";

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
    onNavigateUp?: () => void;
    hideParents?: boolean;
    emptyMessage: string;
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
                  icon={
                    root
                      ? schemeIcon(suggestion.scheme)
                      : suggestion.kind === "dir"
                        ? Folder
                        : fileKindIcon(suggestion.name)
                  }
                  title={root ? schemeLabel(suggestion.scheme) : suggestion.name}
                  suffix={suggestion.suffix}
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
