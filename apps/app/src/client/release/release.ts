import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  parseServerProtocol,
  RELEASE_HEADER,
  type ServerProtocol,
  UNNAMED_RELEASES,
} from "@meridian/contracts/release";

declare const __MERIDIAN_RELEASE__: string;

export type ReleasePhase = "current" | "update-available" | "must-reload";

const OWN_RELEASE = __MERIDIAN_RELEASE__;
const IDLE_MS = 3_000;
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

export function observeServer(seen: {
  release: string | null | undefined;
  protocol: ServerProtocol | null | undefined;
}): void {
  const release = seen.release && !UNNAMED_RELEASES.includes(seen.release) ? seen.release : null;
  if (release) serverRelease = release;
  if (seen.protocol && PROTOCOL_VERSION < seen.protocol.minimum) setPhase("must-reload");
  else if (release && release !== OWN_RELEASE && phase === "current") setPhase("update-available");
}

export function requireReload(): void {
  setPhase("must-reload");
}

function requireReloadAtOnce(): void {
  urgent = true;
  setPhase("must-reload");
  maybeReload();
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

export function sendsHeld(): boolean {
  return phase === "must-reload" && !reloadGuardUsed();
}

export function reloadNow(): void {
  window.location.reload();
}

let watching = false;
let lastActivity = Date.now();
let composing = false;
let urgent = false;
let busy: () => boolean = () => false;
let checkTimer: ReturnType<typeof setInterval> | undefined;

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
  const quiet = urgent || Date.now() - lastActivity >= (hidden ? HIDDEN_IDLE_MS : IDLE_MS);
  if (reloadGuardUsed() || composing || !quiet || busy()) return;
  try {
    sessionStorage.setItem(guardKey(), "1");
  } catch {
    return;
  }
  clearInterval(checkTimer);
  reloadNow();
}

export function installReleaseWatch(): void {
  if (watching) return;
  watching = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/"))
      return original(input, init);
    const response = await original(input, init);
    observeServer({
      release: response.headers.get(RELEASE_HEADER),
      protocol: parseServerProtocol(response.headers.get(PROTOCOL_HEADER)),
    });
    return response;
  };

  // The release changed under a tab whose route code is split into files the deploy removed. The
  // import is left to throw: `preventDefault` would resolve it to undefined and break the render.
  // TanStack Router's lazy route component reloads on the same error unless its own once-per-message
  // key is set, and it has no option to turn that off, so set the key to leave the reload to this module.
  window.addEventListener("vite:preloadError", (event) => {
    requireReloadAtOnce();
    const message = (event as Event & { payload?: { message?: unknown } }).payload?.message;
    if (typeof message === "string")
      sessionStorage.setItem(`tanstack_router_reload:${message}`, "1");
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
