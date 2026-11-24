import { t } from "@lingui/core/macro";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { clearDragHint, showDragHint } from "@/core/editor/landing/drag-hint-store";
import { dragPayloadKind } from "@/core/editor/landing/drag-payload";
import { usePhoneShell } from "@/hooks/use-phone-shell";

export type DroppedEntry = { kind: "file"; file: File } | { kind: "folder"; name: string };

let ownerSequence = 0;

// keep: DataTransfer is emptied after the drop handler returns; read it synchronously
function droppedEntries(transfer: DataTransfer): DroppedEntry[] {
  const entries: DroppedEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) entries.push({ kind: "folder", name: entry.name });
    else {
      const file = item.getAsFile();
      if (file) entries.push({ kind: "file", file });
    }
  }
  return entries;
}

type DropProps = {
  onDragEnter: (event: DragEvent) => void;
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
};

export function useFileDrop({
  enabled,
  onDrop,
}: {
  enabled: boolean;
  onDrop: (entries: readonly DroppedEntry[]) => void;
}): { dropProps: DropProps; over: boolean } {
  const phone = usePhoneShell();
  const active = enabled && phone === false;
  const owner = useRef(`file-drop:${++ownerSequence}`);
  const [over, setOver] = useState(false);
  const latest = useRef({ active, onDrop });
  latest.current = { active, onDrop };

  const end = useCallback(() => {
    setOver(false);
    clearDragHint(owner.current);
  }, []);

  useEffect(() => {
    window.addEventListener("dragend", end);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragend", end);
      window.removeEventListener("drop", end);
      end();
    };
  }, [end]);

  const claims = useCallback(
    (event: DragEvent) =>
      latest.current.active && dragPayloadKind(Array.from(event.dataTransfer.types)) === "files",
    [],
  );

  const hover = useCallback(
    (event: DragEvent) => {
      if (!claims(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setOver(true);
      showDragHint(owner.current, { kind: "accept", label: t`Attach to this chat` }, event);
    },
    [claims],
  );

  return {
    over,
    dropProps: {
      onDragEnter: hover,
      onDragOver: hover,
      onDragLeave(event) {
        if (!claims(event)) return;
        // keep: Safari gives no relatedTarget on dragleave, so don't count enter/leave pairs
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget.contains(to)) return;
        end();
      },
      onDrop(event) {
        if (!claims(event)) return;
        event.preventDefault();
        const entries = droppedEntries(event.dataTransfer);
        end();
        if (entries.length > 0) latest.current.onDrop(entries);
      },
    },
  };
}
