/**
 * What a desktop file drop carried, captured while the event is live: its
 * entries and files are dead once the handler returns. Any drop target captures
 * here; the feature that receives the drop walks the capture.
 */
export type DroppedItems = {
  entries: (FileSystemEntry | null)[];
  files: File[];
};

/** Call synchronously inside the drop event. */
export function captureDrop(dataTransfer: DataTransfer): DroppedItems {
  return {
    entries: Array.from(dataTransfer.items ?? []).map((item) =>
      item.kind === "file" ? item.webkitGetAsEntry() : null,
    ),
    files: Array.from(dataTransfer.files ?? []),
  };
}
