import {
  apiImageProxyPath,
  IMAGE_PROXY_REASON_HEADER,
  imageProxyReason,
} from "@meridian/contracts/protocol";
import { useSyncExternalStore } from "react";

const WEB_ADDRESS = /^(?:https?:)?\/\//i;

export function remotePictureSource(src: string): string | null {
  return WEB_ADDRESS.test(src) ? (src.startsWith("//") ? `https:${src}` : src) : null;
}

/**
 * Where Flow's own clipboard HTML and drag HTML carry a remote picture's address. The browser
 * never fetches a `data-` attribute, so copying a picture out of the editor starts no request;
 * the parse rule reads it back, and pasting inside Flow lands the same remote picture.
 */
export const REMOTE_SRC_ATTRIBUTE = "data-remote-src";

export function clipboardRemoteSource(value: string | null): string | null {
  const address = value === null ? null : remotePictureSource(value.trim());
  if (!address) return null;
  try {
    const url = new URL(address);
    return url.hostname ? address : null;
  } catch {
    return null;
  }
}

export type RemoteImageStatus = { kind: "loading" } | { kind: "loaded" } | { kind: "failed" };

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
    const response = await fetch(apiImageProxyPath(address));
    if (!response.ok) {
      console.warn(
        "Remote image refused",
        address,
        imageProxyReason(response.headers.get(IMAGE_PROXY_REASON_HEADER)),
      );
      setStatus(address, { kind: "failed" });
      return;
    }
    // Read to the end so the browser keeps the answer for the `<img>` that follows.
    await response.blob();
    setStatus(address, { kind: "loaded" });
  } catch (error) {
    console.warn("Remote image fetch failed", address, error);
    setStatus(address, { kind: "failed" });
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
