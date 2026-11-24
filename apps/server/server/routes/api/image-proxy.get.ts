import {
  IMAGE_PROXY_MAX_BYTES,
  IMAGE_PROXY_REASON_HEADER,
  type ImageProxyReason,
} from "@meridian/contracts/protocol";
import { defineEventHandler, getQuery } from "nitro/h3";
import { fetch } from "undici";
import { requireAppUser } from "../../lib/auth-gate.js";
import {
  PrivateAddressError,
  publicAddressDispatcher,
} from "../../lib/public-address-dispatcher.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const DAY_SECONDS = 24 * 60 * 60;

const REFUSAL_STATUS: Record<ImageProxyReason, number> = {
  too_large: 413,
  not_image: 415,
  not_allowed: 403,
  port: 403,
  unreachable: 502,
  timeout: 504,
};

class Refusal extends Error {
  constructor(readonly reason: ImageProxyReason) {
    super(reason);
  }
}

// keep: default ports only: a writer-chosen address is not a way to probe other ports
function remoteImageUrl(raw: string): URL {
  const url = URL.canParse(raw) ? new URL(raw) : null;
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Refusal("not_allowed");
  }
  if (url.port !== "") throw new Refusal("port");
  return url;
}

function refusalOf(error: unknown): Refusal {
  if (error instanceof Refusal) return error;
  const cause = error instanceof Error ? error.cause : null;
  if (cause instanceof PrivateAddressError) return new Refusal("not_allowed");
  const code = (cause as { code?: string } | null)?.code ?? "";
  const timedOut =
    (error instanceof Error && error.name === "TimeoutError") || /^UND_ERR_.*TIMEOUT$/.test(code);
  return new Refusal(timedOut ? "timeout" : "unreachable");
}

// keep: read the body only up to the cap: a Content-Length is the remote's claim, not a limit
async function readCapped(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of body) {
    received += chunk.byteLength;
    if (received > IMAGE_PROXY_MAX_BYTES) throw new Refusal("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const MAX_CONCURRENT_PER_ACCOUNT = 4;
const running = new Map<string, { active: number; waiting: Array<() => void> }>();

async function withAccountSlot<T>(accountId: string, run: () => Promise<T>): Promise<T> {
  const slots = running.get(accountId) ?? { active: 0, waiting: [] };
  running.set(accountId, slots);
  if (slots.active >= MAX_CONCURRENT_PER_ACCOUNT) {
    await new Promise<void>((resolve) => slots.waiting.push(resolve));
  } else {
    slots.active++;
  }
  try {
    return await run();
  } finally {
    const next = slots.waiting.shift();
    if (next) next();
    else if (--slots.active === 0) running.delete(accountId);
  }
}

async function fetchImage(raw: string): Promise<{ type: string; bytes: Uint8Array<ArrayBuffer> }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url = remoteImageUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url, {
      dispatcher: publicAddressDispatcher,
      redirect: "manual",
      signal,
      headers: { accept: "image/*" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = remoteImageUrl(new URL(location, url).href);
      continue;
    }
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Refusal("unreachable");
    }
    if (!/^image\//i.test(type)) {
      await response.body.cancel();
      throw new Refusal("not_image");
    }
    return { type, bytes: await readCapped(response.body as ReadableStream<Uint8Array>) };
  }
  throw new Refusal("unreachable");
}

export default defineEventHandler(async (event) => {
  const { user } = await requireAppUser(event);
  try {
    const { type, bytes } = await withAccountSlot(user.userId, () =>
      fetchImage(String(getQuery(event).url ?? "")),
    );
    return new Response(bytes, {
      headers: {
        "content-type": type,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": `private, max-age=${DAY_SECONDS}`,
      },
    });
  } catch (error) {
    const { reason } = refusalOf(error);
    return new Response(null, {
      status: REFUSAL_STATUS[reason],
      headers: { [IMAGE_PROXY_REASON_HEADER]: reason, "cache-control": "no-store" },
    });
  }
});
