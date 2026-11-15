/**
 * Remote pictures: web addresses Flow never fetches on its own. A page that loaded one would
 * tell its host who is reading and, in a chat, could carry the writer's text in the address.
 * A picture shows its address instead, and the writer's click loads it through Flow's image
 * proxy (`/api/image-proxy`), which is the only way the page draws one.
 *
 * The click asks the proxy first, so a refusal can say why; the proxy's answer is then in the
 * browser's cache for the `<img>`. A load lasts for the life of the tab and applies to that
 * address wherever it appears. Nothing is stored.
 */
import {
  apiImageProxyPath,
  IMAGE_PROXY_REASON_HEADER,
  type ImageProxyReason,
  imageProxyReason,
} from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";

const WEB_ADDRESS = /^(?:https?:)?\/\//i;

/** The absolute address of a web picture source (a protocol-relative one is https), or null. */
export function remotePictureSource(src: string): string | null {
  return WEB_ADDRESS.test(src) ? (src.startsWith("//") ? `https:${src}` : src) : null;
}

export const proxiedImageSrc = apiImageProxyPath;

export type RemoteImageStatus =
  | { kind: "loading" }
  | { kind: "loaded" }
  /** `null` when the proxy never answered (offline, signed out). */
  | { kind: "failed"; reason: ImageProxyReason | null };

const statuses = new Map<string, RemoteImageStatus>();
const listeners = new Set<() => void>();

function setStatus(address: string, status: RemoteImageStatus): void {
  statuses.set(address, status);
  for (const listener of listeners) listener();
}

export async function loadRemoteImage(address: string): Promise<void> {
  const current = statuses.get(address);
  if (current?.kind === "loading" || current?.kind === "loaded") return;
  setStatus(address, { kind: "loading" });
  try {
    const response = await fetch(proxiedImageSrc(address));
    if (!response.ok) {
      setStatus(address, {
        kind: "failed",
        reason: imageProxyReason(response.headers.get(IMAGE_PROXY_REASON_HEADER)),
      });
      return;
    }
    // Read to the end so the browser keeps the answer for the `<img>` that follows.
    await response.blob();
    setStatus(address, { kind: "loaded" });
  } catch {
    setStatus(address, { kind: "failed", reason: null });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRemoteImageStatus(address: string | null): RemoteImageStatus | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (address === null ? undefined : statuses.get(address)),
    () => undefined,
  );
}

export function useRemoteImageLoaded(address: string | null): boolean {
  return useRemoteImageStatus(address)?.kind === "loaded";
}
