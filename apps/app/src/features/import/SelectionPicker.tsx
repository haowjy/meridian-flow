/** The shared way to choose files: hidden inputs, a drop zone and the two buttons. */
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Loader2 } from "lucide-react";
import { type DragEvent, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { captureDrop, type DroppedItems } from "@/lib/dropped-items";
import { cn } from "@/lib/utils";
import type { ReaderState, useSelectionReader } from "./use-selection-reader";

/** Whether this browser can pick a whole folder. iOS reports it but cannot. */
export function canPickFolders(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input");
  if (!("webkitdirectory" in input)) return false;
  const ios =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return !ios;
}

/** A file drag over an element, counted so crossing its children does not flicker. */
export function useFileDragOver(onFiles: (items: DroppedItems) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
  return {
    over,
    props: {
      onDragEnter(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave(event: DragEvent) {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop(event: DragEvent) {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setOver(false);
        onFiles(captureDrop(event.dataTransfer));
      },
    },
  };
}

type Reader = ReturnType<typeof useSelectionReader>;

export function useSelectionPicker(reader: Reader) {
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderPicking = useMemo(canPickFolders, []);
  // After Choose again the choices come back; the first takes focus from the button that left.
  const [choosingAgain, setChoosingAgain] = useState(false);
  const drag = useFileDragOver((items) => void reader.drop(items));
  const inputs = (
    <>
      <input
        ref={folderInput}
        type="file"
        hidden
        data-import-input="folder"
        // The attribute is non-standard; React passes it through as written.
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void reader.pick(files);
        }}
      />
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        data-import-input="files"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void reader.pick(files);
        }}
      />
    </>
  );
  return {
    inputs,
    drag,
    folderPicking,
    chooseFolder: () => folderInput.current?.click(),
    chooseFiles: () => filesInput.current?.click(),
    choosingAgain,
    /**
     * Back to the choices: folder, files or a drop. The first choice may have been
     * any of them, and only the writer knows which shape this one should take.
     */
    chooseAgain: () => {
      reader.reset();
      setChoosingAgain(true);
    },
  };
}

export function PickZone({
  state,
  picker,
  prompt,
}: {
  state: Extract<ReaderState, { status: "empty" | "reading" }>;
  picker: ReturnType<typeof useSelectionPicker>;
  prompt?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-col items-center justify-center gap-4 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
        picker.drag.over ? "border-border-focus bg-muted" : "border-border",
      )}
    >
      {state.status === "reading" ? (
        <div role="status" className="flex flex-col items-center gap-1.5">
          <Loader2
            aria-hidden
            className="size-5 animate-spin text-ink-muted motion-reduce:animate-none"
          />
          <p className="text-sm font-medium text-foreground">
            {state.name ? t`Reading ${state.name}…` : t`Reading…`}
          </p>
          <p className="text-caption text-ink-muted">
            {plural(state.count, { one: "# file so far", other: "# files so far" })}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-foreground">
            {prompt ?? <Trans>Drop a folder or files here</Trans>}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {picker.folderPicking ? (
              <Button
                type="button"
                variant="outline"
                data-first
                autoFocus={picker.choosingAgain}
                onClick={picker.chooseFolder}
              >
                <Trans>Choose folder…</Trans>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              data-first={picker.folderPicking ? undefined : ""}
              autoFocus={picker.choosingAgain && !picker.folderPicking}
              onClick={picker.chooseFiles}
            >
              <Trans>Choose files…</Trans>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
