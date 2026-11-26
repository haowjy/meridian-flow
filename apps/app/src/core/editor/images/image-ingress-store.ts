const NOTICE_LIFETIME_MS = 6_000;

export type ImageIngressNotice = { message: string; token: number };

export type ImageIngressStatus = {
  dropActive: boolean;
  notice: ImageIngressNotice | null;
};

export type ImageIngressStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ImageIngressStatus;
  setDropActive: (active: boolean) => void;
  refuse: (message: string) => void;
  dismiss: () => void;
  destroy: () => void;
};

const IDLE: ImageIngressStatus = Object.freeze({ dropActive: false, notice: null });

export function createImageIngressStore(): ImageIngressStore {
  const listeners = new Set<() => void>();
  let status: ImageIngressStatus = IDLE;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  let issued = 0;

  const publish = (next: ImageIngressStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };

  const cancelExpiry = () => {
    if (expiry === null) return;
    clearTimeout(expiry);
    expiry = null;
  };

  const refuse = (message: string) => {
    cancelExpiry();
    issued += 1;
    const token = issued;
    publish({ ...status, notice: { message, token } });
    expiry = setTimeout(() => {
      expiry = null;
      // Only this notice: a later one has replaced it and must not be silenced by an expiry
      // queued for the one before.
      if (status.notice?.token === token) publish({ ...status, notice: null });
    }, NOTICE_LIFETIME_MS);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => status,
    setDropActive(active) {
      if (status.dropActive === active) return;
      publish({ ...status, dropActive: active });
    },
    refuse,
    dismiss() {
      cancelExpiry();
      if (status.notice) publish({ ...status, notice: null });
    },
    destroy() {
      cancelExpiry();
      listeners.clear();
      status = IDLE;
    },
  };
}
