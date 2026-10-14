/** Reads what the writer picked or dropped, showing a running count, and replaces it on a new pick. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DroppedItems } from "@/lib/dropped-items";
import { readDropped } from "./read-dropped";
import { readPicked } from "./read-picked";
import { EMPTY_SELECTION, type Selection } from "./selection";

export type ReaderState =
  | { status: "empty" }
  | { status: "reading"; name: string; count: number }
  | { status: "ready"; selection: Selection };

export function useSelectionReader() {
  const [state, setState] = useState<ReaderState>({ status: "empty" });
  const current = useRef<AbortController | null>(null);

  const begin = useCallback(() => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return controller;
  }, []);

  const drop = useCallback(
    async (items: DroppedItems) => {
      const controller = begin();
      setState({ status: "reading", name: "", count: 0 });
      let lastPaint = 0;
      const selection = await readDropped(items, {
        signal: controller.signal,
        onProgress: (count, name) => {
          const now = performance.now();
          if (now - lastPaint < 100) return;
          lastPaint = now;
          if (!controller.signal.aborted) setState({ status: "reading", name, count });
        },
      });
      if (!controller.signal.aborted) setState({ status: "ready", selection });
    },
    [begin],
  );

  const pick = useCallback(
    async (files: readonly File[]) => {
      const controller = begin();
      setState({
        status: "reading",
        name: files[0]?.webkitRelativePath.split("/")[0] ?? "",
        count: files.length,
      });
      const selection = files.length > 0 ? await readPicked(files) : EMPTY_SELECTION;
      if (!controller.signal.aborted) setState({ status: "ready", selection });
    },
    [begin],
  );

  const reset = useCallback(() => {
    current.current?.abort();
    setState({ status: "empty" });
  }, []);

  useEffect(() => () => current.current?.abort(), []);

  return { state, drop, pick, reset };
}
