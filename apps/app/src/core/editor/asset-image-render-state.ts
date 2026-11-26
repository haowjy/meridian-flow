import { t } from "@lingui/core/macro";
import { resolveDocumentHref } from "@meridian/contracts";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { apiImageProxyPath } from "@meridian/contracts/protocol";
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

import { documentDownloadUrl, getFigureSignedUrl } from "@/client/api/figures-api";
import { httpErrorStatus } from "@/client/api/http-client";

import {
  assetDocumentIdFromSrc,
  inlinePictureSource,
  remotePictureSource,
  signedUrlRefreshDelayMs,
  useRemoteImageLoaded,
} from "./images";
import {
  type LinkAnswerCache,
  type LinkKey,
  type LinkResolutionEntry,
  linkCacheKey,
  type MountedLinks,
  pictureKeyOfNode,
} from "./links";

export type AssetFileFacts = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
};

export type AssetImageRenderState =
  | { kind: "idle"; url: string | null; message?: string }
  | { kind: "loading"; url: string | null; message?: string }
  | { kind: "ready"; url: string; expiresAt?: string }
  | { kind: "remote"; url: null; address: string }
  | { kind: "file"; url: null; file: AssetFileFacts }
  | { kind: "error"; url: string | null; message: string }
  | { kind: "unavailable"; url: null; message: string };

type PictureTarget =
  | { kind: "empty" }
  | { kind: "literal"; url: string }
  | { kind: "remote"; address: string }
  | { kind: "document"; documentId: string }
  | { kind: "resolving" }
  | { kind: "unanswered" }
  | { kind: "unavailable"; message: string };

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
  const remote = remotePictureSource(src);
  const remoteLoaded = useRemoteImageLoaded(remote);
  if (!src) return { kind: "empty" };
  const assetDocumentId = assetDocumentIdFromSrc(src);
  if (assetDocumentId) return { kind: "document", documentId: assetDocumentId };
  if (!key) {
    // Not a document, so only a supported web URL draws as written. Anything
    // else is a stored source no retry can change: nothing to draw, nothing
    // to retry, and not a gone document.
    const url = inlinePictureSource(src);
    if (url) return { kind: "literal", url };
    if (remote) {
      return remoteLoaded
        ? { kind: "literal", url: apiImageProxyPath(remote) }
        : { kind: "remote", address: remote };
    }
    return { kind: "unavailable", message: t`Image could not be displayed.` };
  }
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
    case "folder":
      return { kind: "unavailable", message: goneMessage() };
  }
}

function goneMessage(): string {
  return t`This image is no longer available.`;
}

function useLinkGeneration(resolution: LinkAnswerCache | null): unknown {
  const subscribe = useMemo(() => resolution?.subscribe ?? noSubscription, [resolution]);
  return useSyncExternalStore(subscribe, () => resolution?.assignment ?? null);
}

function displayedAddress(href: string): string {
  const uri = resolveDocumentHref(href, null)?.uri ?? href;
  const parsed = parseUnifiedContextUri(uri);
  return parsed.ok && parsed.value.scheme === "manuscript" ? parsed.value.path : uri;
}

function pictureTargetIdentity(target: PictureTarget): string {
  switch (target.kind) {
    case "literal":
      return `literal\u0000${target.url}`;
    case "remote":
      return `remote\u0000${target.address}`;
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
  imageDisplayed: () => void;
};

export function useAssetImageRenderState(input: {
  projectId?: string;
  owner?: string;
  src: string;
  ref?: unknown;
  links?: MountedLinks | null;
}): [AssetImageRenderState, AssetImageRenderActions] {
  const { projectId, owner, src } = input;
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
  const fileFactsRef = useRef<AssetFileFacts | null>(null);
  // The picture and document whose `<img>` failed past its refresh: a settled
  // fact, so a re-sign renews the card instead of drawing it again.
  const undrawableRef = useRef<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const generation = useLinkGeneration(resolution);
  const generationRef = useRef(generation);
  generationRef.current = generation;
  // The picture the signed-URL route last called gone, and the generation it
  // was asked in. A later generation asks again.
  const [gone, setGone] = useState<{ picture: string; generation: unknown } | null>(null);
  const picture = `${projectId ?? ""}\u0000${owner ?? ""}\u0000${key ? linkCacheKey(key) : src}`;
  const [shown, setShown] = useState<{ picture: string; state: AssetImageRenderState }>(() => ({
    picture,
    state: initialState(target),
  }));
  const state = shown.picture === picture ? shown.state : initialState(target);
  // The URL an `<img>` is drawing now, and the one whose failure triggered the automatic
  // refresh. Signing is deterministic to the second, so the refresh often returns that same
  // URL: React then sets no new `src` and no second error would arrive to end in the card.
  const drawnUrlRef = useRef<string | null>(null);
  drawnUrlRef.current = state.url;
  const failedUrlRef = useRef<string | null>(null);

  const goneIsStale = gone !== null && gone.picture === picture && gone.generation !== generation;
  useEffect(() => {
    if (!goneIsStale) return;
    setGone(null);
    setRefreshToken((token) => token + 1);
  }, [goneIsStale]);

  const unanswered = target.kind === "unanswered";
  const retry = useCallback(() => {
    if (unanswered && key && resolution) void resolution.resolve(key);
    else setRefreshToken((token) => token + 1);
  }, [key, resolution, unanswered]);
  const imageDisplayed = useCallback(() => {
    retryStateRef.current.state = { automaticRefreshUsed: false };
    failedUrlRef.current = null;
  }, []);
  const imageLoadFailed = useCallback(() => {
    const setState = showFor(setShown, picture);
    if (!assetDocumentId) {
      setState({ kind: "unavailable", url: null, message: t`Image could not be displayed.` });
      return;
    }
    const transition = reduceAssetImageLoadFailure(
      retryStateRef.current.state,
      loadInFlightRef.current,
    );
    retryStateRef.current.state = transition.state;
    if (transition.action === "ignore") return;
    if (transition.action === "refresh") {
      failedUrlRef.current = drawnUrlRef.current;
      setRefreshToken((token) => token + 1);
      return;
    }
    undrawableRef.current = `${picture}\u0000${assetDocumentId}`;
    const file = fileFactsRef.current;
    setState(
      file
        ? { kind: "file", url: null, file }
        : { kind: "unavailable", url: null, message: t`Image could not be displayed.` },
    );
  }, [assetDocumentId, picture]);

  // Keyed by `targetIdentity`, the target's value: the object is rebuilt
  // every render, and a new one with the same value must not re-sign.
  useEffect(() => {
    const setState = showFor(setShown, picture);
    if (!projectId && (target.kind === "document" || target.kind === "resolving")) {
      setState({
        kind: "error",
        url: null,
        message: t`This figure needs a project to render`,
      });
      return;
    }

    // A new resolution generation (every catalog change) asks again, and the
    // same picture stays on screen while it does, as a signed-URL refresh's does.
    if (target.kind === "resolving") {
      setState((kept) => ({ kind: "loading", url: kept?.url ?? null }));
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
    const undrawable = `${picture}\u0000${routeAssetDocumentId}`;

    async function loadSignedUrl(skipCache: boolean) {
      loadInFlightRef.current = true;
      const askedIn = generationRef.current;
      // The previous URL stays on screen: a refresh must not blink the picture
      // out of the manuscript. It is also the URL about to expire, which is
      // why an error arriving now belongs to the request, not to the picture.
      // A card stays a card while its Download is renewed.
      setState((kept) =>
        kept?.kind === "file" ? kept : { kind: "loading", url: kept?.url ?? null },
      );

      try {
        const signed = await getFigureSignedUrl({
          projectId: routeProjectId,
          assetDocumentId: routeAssetDocumentId,
          ...(owner ? { owner } : {}),
          skipCache,
        });
        if (cancelled) return;
        const file = {
          name: signed.name,
          mimeType: signed.mimeType,
          sizeBytes: signed.sizeBytes,
          downloadUrl: owner ? signed.signedUrl : documentDownloadUrl(routeAssetDocumentId),
        };
        fileFactsRef.current = file;
        if (signed.drawUrl && signed.drawUrl === failedUrlRef.current)
          undrawableRef.current = undrawable;
        const drawn = undrawableRef.current === undrawable ? undefined : signed.drawUrl;
        setState(
          drawn
            ? { kind: "ready", url: drawn, expiresAt: signed.signedUrlExpiresAt }
            : { kind: "file", url: null, file },
        );
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
  }, [targetIdentity, picture, projectId, owner, refreshToken]);

  return [state, { retry, imageLoadFailed, imageDisplayed }];
}

function showFor(
  setShown: Dispatch<SetStateAction<{ picture: string; state: AssetImageRenderState }>>,
  picture: string,
) {
  return (
    next: AssetImageRenderState | ((kept: AssetImageRenderState | null) => AssetImageRenderState),
  ) =>
    setShown((current) => ({
      picture,
      state:
        typeof next === "function"
          ? next(current.picture === picture ? current.state : null)
          : next,
    }));
}

function initialState(target: PictureTarget): AssetImageRenderState {
  switch (target.kind) {
    case "empty":
      return { kind: "idle", url: null, message: t`Missing figure source` };
    case "literal":
      return { kind: "ready", url: target.url };
    case "remote":
      return { kind: "remote", url: null, address: target.address };
    case "document":
    case "resolving":
      return { kind: "loading", url: null };
    case "unanswered":
      return { kind: "error", url: null, message: t`Image could not be displayed.` };
    case "unavailable":
      return { kind: "unavailable", url: null, message: target.message };
  }
}
