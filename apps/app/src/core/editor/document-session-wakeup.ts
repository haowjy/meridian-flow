/** Advisory cross-tab wakes, lifecycle subscriptions and scans; never document authority. */
import type { AccountId } from "@meridian/contracts/protocol";
export type WakeChannel = { post(): void; close(): void };
type WakeReason = "broadcast" | "focus" | "pageshow" | "visible" | "scan";

export function createDocumentWakeChannel(
  accountId: AccountId,
  wake: () => void,
): WakeChannel | null {
  if (typeof BroadcastChannel !== "function") return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(`meridian:f1d:v1:wake/${encodeURIComponent(accountId)}`);
  } catch {
    return null;
  }
  channel.onmessage = wake;
  return { post: () => channel.postMessage({ wake: true }), close: () => channel.close() };
}

export class DocumentSessionWakeup {
  private readonly channel: WakeChannel | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly removeLifecycleListeners: () => void;
  constructor(
    accountId: AccountId,
    private readonly reconcile: (reason: WakeReason) => Promise<void>,
    private readonly intervalMs: number,
    createChannel: ((accountId: AccountId, wake: () => void) => WakeChannel | null) | null,
  ) {
    let channel: WakeChannel | null = null;
    try {
      channel = createChannel?.(accountId, () => this.wake("broadcast")) ?? null;
    } catch {
      /* Wake delivery is advisory; durable reconciliation remains authoritative. */
    }
    this.channel = channel;
    this.removeLifecycleListeners = this.subscribeLifecycle();
  }
  private wake(reason: WakeReason): void {
    void this.reconcile(reason).catch(() => undefined);
  }
  signal(): void {
    try {
      this.channel?.post();
    } catch {
      /* The channel is advisory; durable scans own recovery. */
    }
  }
  schedule(hasWork: boolean): void {
    if (!hasWork) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake("scan");
    }, this.intervalMs);
  }
  close(): void {
    try {
      this.channel?.close();
    } catch {
      /* Wake delivery is advisory and carries no teardown authority. */
    }
  }
  private subscribeLifecycle(): () => void {
    if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
    const focus = () => this.wake("focus");
    const pageshow = () => this.wake("pageshow");
    const visibility = () => {
      if (document.visibilityState === "visible") this.wake("visible");
    };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageshow);
      document.removeEventListener("visibilitychange", visibility);
    };
  }
}
