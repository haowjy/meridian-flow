/** Shared recovery signals; connection owners retain their own retry policy. */
export type ConnectivityHint = "retry-now" | "suspect-offline";
export type ConnectivitySource = object;
export type ConnectivityHintsPort = Pick<
  ConnectivityHints,
  "subscribe" | "reportConnected" | "reportDisconnected"
>;

type Environment = {
  browser: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">;
  random: () => number;
};

export class ConnectivityHints {
  private readonly subscribers = new Set<{
    source: ConnectivitySource;
    listener: (hint: ConnectivityHint) => void;
    lastRetry: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  private readonly connected = new Set<ConnectivitySource>();
  private readonly successfulSources = new Set<ConnectivitySource>();
  private burst: ReturnType<typeof setTimeout> | null = null;
  private stopBrowser: (() => void) | null = null;

  constructor(private readonly environment: Environment) {}

  start(): void {
    if (this.stopBrowser) return;
    const { browser, document } = this.environment;
    const retry = () => this.queueRetry();
    const visible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const offline = () => {
      this.cancelPending();
      for (const subscriber of this.subscribers) {
        // A new network recovery must not be suppressed by a pre-outage wake.
        subscriber.lastRetry = -Infinity;
        subscriber.listener("suspect-offline");
      }
    };
    for (const event of ["online", "focus", "pageshow"]) browser.addEventListener(event, retry);
    browser.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    this.stopBrowser = () => {
      for (const event of ["online", "focus", "pageshow"])
        browser.removeEventListener(event, retry);
      browser.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }

  stop(): void {
    this.stopBrowser?.();
    this.stopBrowser = null;
    this.cancelPending();
  }

  subscribe(source: ConnectivitySource, listener: (hint: ConnectivityHint) => void): () => void {
    const subscriber = {
      source,
      listener,
      lastRetry: -Infinity,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    this.subscribers.add(subscriber);
    return () => {
      if (subscriber.timer !== null) clearTimeout(subscriber.timer);
      this.subscribers.delete(subscriber);
      this.connected.delete(source);
    };
  }

  reportConnected(source: ConnectivitySource): void {
    if (this.connected.has(source)) return;
    this.connected.add(source);
    for (const subscriber of this.subscribers) {
      if (subscriber.source !== source || subscriber.timer === null) continue;
      clearTimeout(subscriber.timer);
      subscriber.timer = null;
    }
    this.successfulSources.add(source);
    this.queueRetry();
  }

  reportDisconnected(source: ConnectivitySource): void {
    this.connected.delete(source);
  }

  private queueRetry(): void {
    if (this.burst !== null) return;
    this.burst = setTimeout(() => {
      this.burst = null;
      const { random } = this.environment;
      for (const subscriber of this.subscribers) {
        if (this.successfulSources.has(subscriber.source) || subscriber.timer !== null) continue;
        subscriber.timer = setTimeout(
          () => {
            subscriber.timer = null;
            subscriber.lastRetry = Date.now();
            subscriber.listener("retry-now");
          },
          Math.max(0, 2_000 - (Date.now() - subscriber.lastRetry)) + random() * 300,
        );
      }
      this.successfulSources.clear();
    }, 50);
  }

  private cancelPending(): void {
    if (this.burst !== null) clearTimeout(this.burst);
    this.burst = null;
    this.successfulSources.clear();
    for (const subscriber of this.subscribers) {
      if (subscriber.timer !== null) clearTimeout(subscriber.timer);
      subscriber.timer = null;
    }
  }
}
