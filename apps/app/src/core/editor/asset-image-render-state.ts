/**
 * What an image or figure shows: which document its source names, and the
 * signed-URL lifecycle that draws a document-backed picture.
 *
 * A picture names a document one of two ways. An upload stores `asset:<id>`.
 * A picture written as an address stores a `ref` (`doc:`/`ahead:`) beside it,
 * and that ref is answered by the editor's link cache like any link's: the
 * same `(ref, href)` key, the same local rule and settlement memo, asked
 * through the editor's one requester while the picture is mounted. A
 * ref-less source that is a document address (`uploads://seal.png`) is asked
 * by its address, as a ref-less link is. A document answer draws exactly as
 * an `asset:` picture does. A web or `data:` source renders as written; no
 * other source is ever handed to the browser as a URL.
 *
 * Whether a document is gone is the server's answer, never a guess: the link
 * resolver's for a ref, the signed-URL route's 404 for a document (which also
 * hides an unreadable one, so a stored id is never a capability). A gone
 * document is asked again when the catalog changes, so restoring it draws it.
 */

import { t } from "@lingui/core/macro";
import { resolveDocumentHref } from "@meridian/contracts";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { getFigureSignedUrl } from "@/client/api/figures-api";
import { httpErrorStatus } from "@/client/api/http-client";

import { assetDocumentIdFromSrc, signedUrlRefreshDelayMs } from "./images";
import {
  type LinkAnswerCache,
  type LinkKey,
  type LinkResolutionEntry,
  linkCacheKey,
  type MountedLinks,
  pictureKeyOfNode,
} from "./links";

export type AssetImageRenderState =
  | { kind: "idle"; url: string | null; message?: string }
  | { kind: "loading"; url: string | null; message?: string }
  | { kind: "ready"; url: string; expiresAt?: string }
  | { kind: "error"; url: string | null; message: string }
  /**
   * Nothing to draw, and nothing to retry: an address nothing has been
   * uploaded to yet (it draws itself when a file arrives there), or a
   * document that is gone.
   */
  | { kind: "unavailable"; url: null; message: string };

/** What a picture's source names, before any URL is signed. */
type PictureTarget =
  | { kind: "empty" }
  | { kind: "literal"; url: string }
  | { kind: "document"; documentId: string }
  /** No answer yet: no resolver registered, or the question is out. */
  | { kind: "resolving" }
  /** The question failed. Retry asks again. */
  | { kind: "unanswered" }
  | { kind: "unavailable"; message: string };

/**
 * Not asked yet: no resolver is registered, or the requester has not asked
 * this generation about the picture. Distinct from a failed question (null).
 */
const UNASKED = "unasked" as const;
const noSubscription = () => () => {};

function usePictureTarget(
  src: string,
  key: LinkKey | null,
  resolution: LinkAnswerCache | null,
): PictureTarget {
  const cache = key ? resolution : null;
  const subscribe = useMemo(() => cache?.subscribe ?? noSubscription, [cache]);
  const entry = useSyncExternalStore<LinkResolutionEntry | null | typeof UNASKED>(subscribe, () => {
    if (!cache || !key) return null;
    if (!cache.available) return UNASKED;
    return cache.read(key) ?? (cache.failed(key) ? null : UNASKED);
  });
  if (!src) return { kind: "empty" };
  const assetDocumentId = assetDocumentIdFromSrc(src);
  if (assetDocumentId) return { kind: "document", documentId: assetDocumentId };
  if (!key) return { kind: "literal", url: src };
  // A document address is not a URL: an editor with no link lane has no way
  // to ask about it, which is a question that could not be asked.
  if (!cache) return { kind: "unanswered" };
  if (entry === UNASKED || entry?.state === "pending") return { kind: "resolving" };
  if (!entry) return { kind: "unanswered" };
  switch (entry.state) {
    case "document":
      return { kind: "document", documentId: entry.document.documentId };
    case "missing": {
      const path = displayedAddress(key.href);
      return { kind: "unavailable", message: t`No image has been uploaded to ${path} yet.` };
    }
    case "gone":
      return { kind: "unavailable", message: goneMessage() };
  }
}

function goneMessage(): string {
  return t`This image is no longer available.`;
}

/**
 * The link cache's current generation: a new one is a catalog change, after
 * which a document the server said was gone is worth asking about again.
 */
function useLinkGeneration(resolution: LinkAnswerCache | null): unknown {
  const subscribe = useMemo(() => resolution?.subscribe ?? noSubscription, [resolution]);
  return useSyncExternalStore(subscribe, () => resolution?.assignment ?? null);
}

/** A manuscript picture's address as the writer wrote it: its path from the root. */
function displayedAddress(href: string): string {
  const uri = resolveDocumentHref(href, null)?.uri ?? href;
  return uri.startsWith("manuscript://") ? uri.slice("manuscript://".length) : uri;
}

function pictureTargetIdentity(target: PictureTarget): string {
  switch (target.kind) {
    case "literal":
      return `literal\u0000${target.url}`;
    case "document":
      return `document\u0000${target.documentId}`;
    case "unavailable":
      return `unavailable\u0000${target.message}`;
    default:
      return target.kind;
  }
}

export type AssetImageRetryState = {
  automaticRefreshUsed: boolean;
};

export type AssetImageLoadFailureTransition = {
  state: AssetImageRetryState;
  action: "refresh" | "error" | "ignore";
};

/**
 * What an `<img>` failure means. One automatic signed-URL refresh per picture
 * the writer has actually seen; the next failure shows the reason instead of
 * looping.
 *
 * Two failures are not the picture's fault and must not reach the writer:
 *
 * - **A failure while a load is in flight.** A refresh keeps the previous URL
 *   on screen so the picture does not blink, and that URL is expiring — which
 *   is why a refresh is running. Its error is news about the URL being
 *   replaced, and the load already running is the answer.
 * - **A failure long after the last one.** The budget is spent per displayed
 *   picture rather than per node view, because a node view lives as long as
 *   the chapter is open: one blip in the first minute must not leave the
 *   second hour's expiry with nothing but a placeholder. `imageDisplayed`
 *   returns the budget, and only the browser can say the picture rendered.
 */
export function reduceAssetImageLoadFailure(
  state: AssetImageRetryState,
  loadInFlight = false,
): AssetImageLoadFailureTransition {
  if (loadInFlight) return { state, action: "ignore" };
  return state.automaticRefreshUsed
    ? { state, action: "error" }
    : { state: { automaticRefreshUsed: true }, action: "refresh" };
}

export type AssetImageRenderActions = {
  retry: () => void;
  imageLoadFailed: () => void;
  /** The picture is on screen. Report it, or the next expiry has no recovery. */
  imageDisplayed: () => void;
};

export function useAssetImageRenderState(input: {
  projectId?: string;
  src: string;
  /** The picture's stored `ref`, as the node holds it. */
  ref?: unknown;
  /** The editor's link cache, which answers the ref, and its requester. */
  links?: MountedLinks | null;
}): [AssetImageRenderState, AssetImageRenderActions] {
  const { projectId, src } = input;
  const resolution = input.links?.resolution ?? null;
  const requester = input.links?.requester ?? null;
  const stored = pictureKeyOfNode({ ref: input.ref, src });
  // Stable across renders while the stored link is: the subscription and the
  // retry belong to the key, not to a fresh object.
  const keyRef = stored?.ref ?? null;
  const keyLink = stored?.href ?? null;
  const key = useMemo<LinkKey | null>(
    () => (keyLink ? { ref: keyRef, href: keyLink } : null),
    [keyRef, keyLink],
  );
  // Asked about while shown, and released on unmount or when the key changes.
  useEffect(() => (key && requester ? requester.watch(key) : undefined), [key, requester]);
  const target = usePictureTarget(src, key, resolution);
  const targetIdentity = pictureTargetIdentity(target);
  const assetDocumentId = target.kind === "document" ? target.documentId : null;
  const assetIdentity = `${projectId ?? ""}\u0000${targetIdentity}`;
  const retryStateRef = useRef<{ identity: string; state: AssetImageRetryState }>({
    identity: assetIdentity,
    state: { automaticRefreshUsed: false },
  });
  if (retryStateRef.current.identity !== assetIdentity) {
    retryStateRef.current = {
      identity: assetIdentity,
      state: { automaticRefreshUsed: false },
    };
  }
  // Whether a signed-URL load is running right now. A ref rather than the
  // rendered state: an `<img>` error arrives between renders, and what it has
  // to be judged against is the request in flight at that instant.
  const loadInFlightRef = useRef(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useLinkGeneration(resolution);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  // The picture the signed-URL route last called gone, and the generation it
  // was asked in. A later generation asks again.
  const [gone, setGone] = useState<{ picture: string; generation: unknown } | null>(null);
  // Which picture this is: its project, and its stored link or its source.
  // A URL on screen belongs to one picture. It stays while that same picture
  // revalidates (a catalog change, a signed-URL refresh), and a node view
  // retargeted to another picture (a ref or source edit, undo, a peer's
  // update) never draws the previous one while the new one loads.
  const picture = `${projectId ?? ""}\u0000${key ? linkCacheKey(key) : src}`;
  const [shown, setShown] = useState<{ picture: string; state: AssetImageRenderState }>(() => ({
    picture,
    state: initialState(target),
  }));
  const state = shown.picture === picture ? shown.state : initialState(target);

  const goneIsStale = gone !== null && gone.picture === picture && gone.generation !== generation;
  useEffect(() => {
    if (!goneIsStale) return;
    setGone(null);
    setRefreshToken((token) => token + 1);
  }, [goneIsStale]);

  const unanswered = target.kind === "unanswered";
  const retry = useCallback(() => {
    // A question that failed is asked again; anything else signs a fresh URL.
    if (unanswered && key && resolution) void resolution.resolve(key);
    else setRefreshToken((token) => token + 1);
  }, [key, resolution, unanswered]);
  const imageDisplayed = useCallback(() => {
    retryStateRef.current.state = { automaticRefreshUsed: false };
  }, []);
  const imageLoadFailed = useCallback(() => {
    const setState = showFor(setShown, picture);
    if (!assetDocumentId) {
      setState({ kind: "error", url: null, message: t`Image could not be displayed.` });
      return;
    }
    const transition = reduceAssetImageLoadFailure(
      retryStateRef.current.state,
      loadInFlightRef.current,
    );
    retryStateRef.current.state = transition.state;
    if (transition.action === "ignore") return;
    if (transition.action === "refresh") {
      setRefreshToken((token) => token + 1);
      return;
    }
    setState({ kind: "error", url: null, message: t`Image could not be displayed.` });
  }, [assetDocumentId, picture]);

  // Keyed by `targetIdentity`, the target's value: the object is rebuilt
  // every render, and a new one with the same value must not re-sign.
  useEffect(() => {
    const setState = showFor(setShown, picture);
    if (!projectId && (target.kind === "document" || target.kind === "resolving")) {
      setState({
        kind: "error",
        url: null,
        message: t`This stored figure needs a project before it can be rendered.`,
      });
      return;
    }

    // A new resolution generation (every catalog change) asks again, and the
    // same picture stays on screen while it does, as a signed-URL refresh's does.
    if (target.kind === "resolving") {
      setState((kept) => ({ kind: "loading", url: kept }));
      return;
    }

    if (target.kind !== "document" || !projectId) {
      setState(initialState(target));
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const routeProjectId = projectId;
    const routeAssetDocumentId = target.documentId;

    async function loadSignedUrl(skipCache: boolean) {
      loadInFlightRef.current = true;
      const askedIn = generationRef.current;
      // The previous URL stays on screen: a refresh must not blink the picture
      // out of the manuscript. It is also the URL about to expire, which is
      // why an error arriving now belongs to the request, not to the picture.
      setState((kept) => ({ kind: "loading", url: kept }));

      try {
        const signed = await getFigureSignedUrl({
          projectId: routeProjectId,
          assetDocumentId: routeAssetDocumentId,
          skipCache,
        });
        if (cancelled) return;
        setState({ kind: "ready", url: signed.signedUrl, expiresAt: signed.signedUrlExpiresAt });
        const delay = signedUrlRefreshDelayMs(signed.signedUrlExpiresAt);
        refreshTimer = setTimeout(() => void loadSignedUrl(true), delay);
      } catch (error) {
        if (cancelled) return;
        if (httpErrorStatus(error) === 404) {
          setGone({ picture, generation: askedIn });
          setState({ kind: "unavailable", url: null, message: goneMessage() });
          return;
        }
        setState({
          kind: "error",
          url: null,
          message: error instanceof Error ? error.message : t`Figure could not be loaded.`,
        });
      } finally {
        loadInFlightRef.current = false;
      }
    }

    void loadSignedUrl(refreshToken > 0);

    return () => {
      cancelled = true;
      loadInFlightRef.current = false;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [targetIdentity, picture, projectId, refreshToken]);

  return [state, { retry, imageLoadFailed, imageDisplayed }];
}

/**
 * Sets the state shown for one picture. An update may keep the URL already
 * on screen only when that URL is this same picture's.
 */
function showFor(
  setShown: Dispatch<SetStateAction<{ picture: string; state: AssetImageRenderState }>>,
  picture: string,
) {
  return (next: AssetImageRenderState | ((keptUrl: string | null) => AssetImageRenderState)) =>
    setShown((current) => ({
      picture,
      state:
        typeof next === "function"
          ? next(current.picture === picture ? current.state.url : null)
          : next,
    }));
}

/** The state a target draws before any URL is signed. */
function initialState(target: PictureTarget): AssetImageRenderState {
  switch (target.kind) {
    case "empty":
      return { kind: "idle", url: null, message: t`Missing figure source` };
    case "literal":
      return { kind: "ready", url: target.url };
    case "document":
    case "resolving":
      return { kind: "loading", url: null };
    case "unanswered":
      return { kind: "error", url: null, message: t`Image could not be displayed.` };
    case "unavailable":
      return { kind: "unavailable", url: null, message: target.message };
  }
}
