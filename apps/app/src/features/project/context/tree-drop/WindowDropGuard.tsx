/** Mounts the window-level guard that keeps a stray file drop from replacing the app. */
import { useWindowDropGuard } from "./tree-drop";

export function WindowDropGuard() {
  useWindowDropGuard();
  return null;
}
