/** Test doubles for browser file objects. */

export function pickedFile(relativePath: string, content: string | Uint8Array): File {
  const file = new File([content as BlobPart], relativePath.split("/").at(-1) ?? relativePath);
  Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  return file;
}

type FakeNode =
  | { name: string; content: string | Uint8Array; broken?: boolean }
  | { name: string; children: FakeNode[]; broken?: boolean };

/** A directory entry that hands out its children `batch` at a time, as browsers do. */
export function fakeDirectory(
  node: FakeNode & { children: FakeNode[] },
  batch = 2,
): FileSystemDirectoryEntry {
  return {
    name: node.name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let offset = 0;
      return {
        readEntries(ok: FileSystemEntriesCallback, fail?: ErrorCallback) {
          if (node.broken) return fail?.(new DOMException("denied", "NotAllowedError"));
          const next = node.children.slice(offset, offset + batch).map(fakeEntry);
          offset += batch;
          ok(next);
        },
      } as FileSystemDirectoryReader;
    },
    getFile(name: string, _options: unknown, ok: FileSystemEntryCallback, fail?: ErrorCallback) {
      const child = node.children.find(
        (candidate) => candidate.name === name && "content" in candidate,
      );
      if (child) ok(fakeEntry(child));
      else fail?.(new DOMException("none", "NotFoundError"));
    },
    getDirectory(
      name: string,
      _options: unknown,
      ok: FileSystemEntryCallback,
      fail?: ErrorCallback,
    ) {
      const child = node.children.find(
        (candidate) => candidate.name === name && "children" in candidate,
      );
      if (child) ok(fakeEntry(child));
      else fail?.(new DOMException("none", "NotFoundError"));
    },
  } as unknown as FileSystemDirectoryEntry;
}

export function fakeEntry(node: FakeNode): FileSystemEntry {
  if ("children" in node) return fakeDirectory(node);
  return {
    name: node.name,
    isFile: true,
    isDirectory: false,
    file(ok: FileCallback, fail?: ErrorCallback) {
      if (node.broken) fail?.(new DOMException("denied", "NotAllowedError"));
      else ok(new File([node.content as BlobPart], node.name));
    },
  } as unknown as FileSystemFileEntry;
}
