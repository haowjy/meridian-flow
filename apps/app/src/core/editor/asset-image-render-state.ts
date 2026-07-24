/** Shared signed-URL lifecycle for asset-backed images rendered in React surfaces. */
import { t } from "@lingui/core/macro";
import { useCallback, useEffect, useState } from "react";

import { getFigureSignedUrl } from "@/client/api/figures-api";

import { assetDocumentIdFromSrc, signedUrlRefreshDelayMs } from "./image-workflow";

export type AssetImageRenderState =
  | { kind: "idle"; url: string | null; message?: string }
  | { kind: "loading"; url: string | null; message?: string }
  | { kind: "ready"; url: string; expiresAt?: string }
  | { kind: "error"; url: string | null; message: string };

export function useAssetImageRenderState(input: {
  projectId?: string;
  src: string;
}): [AssetImageRenderState, () => void] {
  const { projectId, src } = input;
  const assetDocumentId = assetDocumentIdFromSrc(src);
  const [refreshToken, setRefreshToken] = useState(0);
  const [state, setState] = useState<AssetImageRenderState>(() => {
    if (!src) return { kind: "idle", url: null, message: t`Missing figure source` };
    return assetDocumentId ? { kind: "loading", url: null } : { kind: "ready", url: src };
  });

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  useEffect(() => {
    if (!src) {
      setState({ kind: "idle", url: null, message: t`Missing figure source` });
      return;
    }

    if (!assetDocumentId) {
      setState({ kind: "ready", url: src });
      return;
    }

    if (!projectId) {
      setState({
        kind: "error",
        url: null,
        message: t`This stored figure needs a project before it can be rendered.`,
      });
      return;
    }

    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const routeProjectId = projectId;
    const routeAssetDocumentId = assetDocumentId;

    async function loadSignedUrl(skipCache: boolean) {
      setState((current) => ({ kind: "loading", url: current.url }));

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
        setState({
          kind: "error",
          url: null,
          message: error instanceof Error ? error.message : t`Figure could not be loaded.`,
        });
      }
    }

    void loadSignedUrl(refreshToken > 0);

    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [assetDocumentId, projectId, refreshToken, src]);

  return [state, refresh];
}
