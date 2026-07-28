/**
 * Editor bind horizon — waits briefly for every available pre-bind evidence source.
 *
 * Expiry or source failure degrades evidence but always permits binding.
 */

export const EDITOR_BIND_HORIZON_TIMEOUT_MS = 5_000;

export type EditorBindHorizonResult = {
  evidenceDegraded: boolean;
};

export function waitForEditorBindHorizon({
  localPersistence,
  firstServerSync,
  timeoutMs = EDITOR_BIND_HORIZON_TIMEOUT_MS,
}: {
  localPersistence: PromiseLike<void>;
  firstServerSync?: PromiseLike<void>;
  timeoutMs?: number;
}): Promise<EditorBindHorizonResult> {
  return new Promise((resolve) => {
    let complete = false;
    const finish = (evidenceDegraded: boolean) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      resolve({ evidenceDegraded });
    };
    const timeout = setTimeout(() => finish(true), timeoutMs);
    const sources = firstServerSync
      ? [Promise.resolve(localPersistence), Promise.resolve(firstServerSync)]
      : [Promise.resolve(localPersistence)];
    void Promise.all(
      sources.map((source) =>
        source.then(
          () => false,
          () => true,
        ),
      ),
    ).then((failed) => finish(failed.some(Boolean)));
  });
}
