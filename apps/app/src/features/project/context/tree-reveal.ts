/**
 * Asks whichever tree holds a folder to open it. A menu that moves or copies rows sits outside the
 * destination's tree, which owns its own expansion, so the request goes by the folder's id.
 */
type Listener = (folderId: string) => void;

const listeners = new Set<Listener>();

export function revealFolder(folderId: string) {
  for (const listener of listeners) listener(folderId);
}

export function subscribeFolderReveal(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
