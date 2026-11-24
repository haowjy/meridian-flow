import type { ChangeEvent, RefObject } from "react";
// keep: Feature-detect webkitdirectory but exclude iOS; iOS reports support yet cannot pick a folder.
export function canPickFolders(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.createElement("input");
  if (!("webkitdirectory" in input)) return false;
  const ios =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return !ios;
}

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
