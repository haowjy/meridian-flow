const queued = new Set<() => void>();

export function afterCurrentDispatch(react: () => void): void {
  if (queued.has(react)) return;
  queued.add(react);
  queueMicrotask(() => {
    queued.delete(react);
    react();
  });
}
