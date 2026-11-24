export type DroppedItems = {
  entries: (FileSystemEntry | null)[];
  files: File[];
};

export function captureDrop(dataTransfer: DataTransfer): DroppedItems {
  return {
    entries: Array.from(dataTransfer.items ?? []).map((item) =>
      item.kind === "file" ? item.webkitGetAsEntry() : null,
    ),
    files: Array.from(dataTransfer.files ?? []),
  };
}
