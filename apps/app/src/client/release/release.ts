/**
 * What this tab knows about the app being deployed under it: one app-wide store behind the header
 * word, fed by the release headers on every API answer and the thread socket's `connected` frame.
 *
 * - `current`: nothing newer is known.
 * - `update-available`: the server's release differs from this bundle's. The writer reloads.
 * - `must-reload`: the server can no longer understand this tab (its protocol is below the
 *   server's minimum), or the tab learned it is stale some other way: a lazy chunk that is gone,
 *   a document room that needs a newer schema, a command the server cannot read. New sends are
 *   held in the driver's journal and the tab reloads by itself once the writer has paused.
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  parseServerProtocol,
  RELEASE_HEADER,
  type ServerProtocol,
} from "@meridian/contracts/release";

declare const __MERIDIAN_RELEASE__: string;

export type ReleasePhase = "current" | "update-available" | "must-reload";

const OWN_RELEASE = __MERIDIAN_RELEASE__;
/** No keystroke or pointer press for this long before the tab reloads itself. */
const IDLE_MS = 3_000;
/** A hidden tab is not being typed in; this only lets the editors' local saves land first. */
const HIDDEN_IDLE_MS = 1_500;
const CHECK_MS = 1_000;

let phase: ReleasePhase = "current";
let serverRelease: string | null = null;
const listeners = new Set<() => void>();

function setPhase(next: ReleasePhase): void {
  if (next === phase) return;
  phase = next;
  for (const listener of [...listeners]) listener();
  if (next === "must-reload") startReloading();
}

export const releaseStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: (): ReleasePhase => phase,
};

/** What an answer from the server says; a missing field says nothing. */
export function observeServer(seen: {
  release: string | null | undefined;
  protocol: ServerProtocol | null | undefined;
}): void {
  if (seen.release) serverRelease = seen.release;
  if (seen.protocol && PROTOCOL_VERSION < seen.protocol.minimum) setPhase("must-reload");
  else if (seen.release && seen.release !== OWN_RELEASE && phase === "current")
    setPhase("update-available");
}

/** This tab's code is the problem and a reload is the only fix. */
export function requireReload(): void {
  setPhase("must-reload");
}

/**
 * Whether the tab may still reload itself: once per release it would reload into, so a stale bundle
 * served again after the reload cannot loop. The writer's own press is not guarded.
 */
function guardKey(): string {
  return `meridian:release-reload:${OWN_RELEASE}:${serverRelease ?? "unknown"}`;
}

function reloadGuardUsed(): boolean {
  try {
    return sessionStorage.getItem(guardKey()) !== null;
  } catch {
    return true;
  }
}

/** New sends wait in the journal while a reload is on its way. */
export function sendsHeld(): boolean {
  return phase === "must-reload" && !reloadGuardUsed();
}

export function reloadNow(): void {
  window.location.reload();
}

// --- reloading by itself ---

let watching = false;
let lastActivity = Date.now();
let composing = false;
let busy: () => boolean = () => false;
let checkTimer: ReturnType<typeof setInterval> | undefined;

/** The driver says whether a request is mid-send. */
export function watchDelivery(isBusy: () => boolean): void {
  busy = isBusy;
}

function startReloading(): void {
  if (reloadGuardUsed() || checkTimer) return;
  checkTimer = setInterval(maybeReload, CHECK_MS);
  maybeReload();
}

function maybeReload(): void {
  const hidden = document.visibilityState === "hidden";
  const quiet = Date.now() - lastActivity >= (hidden ? HIDDEN_IDLE_MS : IDLE_MS);
  if (composing || !quiet || busy()) return;
  try {
    sessionStorage.setItem(guardKey(), "1");
  } catch {
    return;
  }
  clearInterval(checkTimer);
  reloadNow();
}

/** Browser only; once. Reads the release headers off every API answer and sends this tab's protocol. */
export function installReleaseWatch(): void {
  if (watching) return;
  watching = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/"))
      return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : []));
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    const response = await original(input, { ...init, headers });
    observeServer({
      release: response.headers.get(RELEASE_HEADER),
      protocol: parseServerProtocol(response.headers.get(PROTOCOL_HEADER)),
    });
    return response;
  };

  // The release changed under a tab whose route code is split into files the deploy removed.
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    requireReload();
  });

  const touch = () => {
    lastActivity = Date.now();
  };
  for (const type of ["keydown", "beforeinput", "pointerdown"])
    document.addEventListener(type, touch, true);
  document.addEventListener(
    "compositionstart",
    () => {
      composing = true;
    },
    true,
  );
  document.addEventListener(
    "compositionend",
    () => {
      composing = false;
      touch();
    },
    true,
  );
  document.addEventListener("visibilitychange", () => {
    if (phase === "must-reload") maybeReload();
  });
}
