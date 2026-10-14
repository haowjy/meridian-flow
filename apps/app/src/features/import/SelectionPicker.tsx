/** Hidden native pickers. Choosing starts immediately; cancellation changes nothing. */
import type { ChangeEvent, RefObject } from "react";
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

/**
 * The two hidden file inputs behind "Folder…" and "Files…": the OS picker opens
 * when the caller clicks one through its ref. A pick hands over its files and
 * clears the input so the same choice can be made again.
 */
export function PickInputs({
  folderRef,
  filesRef,
  onPick,
}: {
  folderRef: RefObject<HTMLInputElement | null>;
  filesRef: RefObject<HTMLInputElement | null>;
  onPick: (files: File[]) => void;
}) {
  const handle = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length) onPick(files);
  };
  return (
    <>
      <input
        ref={folderRef}
        type="file"
        hidden
        data-import-input="folder"
        // The attribute is non-standard; React passes it through as written.
        {...{ webkitdirectory: "" }}
        onChange={handle}
      />
      <input
        ref={filesRef}
        type="file"
        multiple
        hidden
        data-import-input="files"
        onChange={handle}
      />
    </>
  );
}
