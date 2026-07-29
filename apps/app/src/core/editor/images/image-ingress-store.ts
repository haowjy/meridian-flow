/**
 * The two things about image ingress that are not in the document.
 *
 * Everything a picture's arrival puts on the page lives in the document (a
 * pending `image` node) or in the plugin state beside it. Two facts cannot:
 *
 * - **A drag is in the air.** Nothing has landed yet, so there is nothing to
 *   own it; the manuscript only dims and says where the drop will go.
 * - **A refusal.** A file that is not an image, a picker with no project
 *   behind it, a site that would not hand over its bytes: each is an event
 *   that changed nothing, and law 5 says the reason is still in view. A
 *   refusal that produced a document change would not be here — it would be
 *   labelled on the node it produced.
 *
 * The notice's life belongs to the store rather than to whoever renders it,
 * for the same reason `passage-notice-store` owns its own: the editor's
 * surfaces mount and unmount, and a message must not outlive its moment
 * because a component happened to stay mounted.
 */

/** Long enough to read one sentence while looking back at the manuscript. */
const NOTICE_LIFETIME_MS = 6_000;

export type ImageIngressNotice = { message: string; token: number };

export type ImageIngressStatus = {
  /** True while a drag carrying files is over the manuscript. */
  dropActive: boolean;
  notice: ImageIngressNotice | null;
};

export type ImageIngressStore = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ImageIngressStatus;
  setDropActive: (active: boolean) => void;
  /** Say what could not be done, in the writer's terms. */
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
    refuse(message) {
      cancelExpiry();
      issued += 1;
      const token = issued;
      publish({ ...status, notice: { message, token } });
      expiry = setTimeout(() => {
        expiry = null;
        // Only this notice: a later refusal has replaced it and must not be
        // silenced by an expiry queued for the one before.
        if (status.notice?.token === token) publish({ ...status, notice: null });
      }, NOTICE_LIFETIME_MS);
    },
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
