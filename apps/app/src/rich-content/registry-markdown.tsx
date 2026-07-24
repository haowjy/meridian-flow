/**
 * Registry-backed Streamdown adapters for document MDX and asset images.
 *
 * Streamdown remains the markdown renderer. This module only teaches it which
 * registered tags are safe and how each registry kind degrades or renders.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeNode } from "@meridian/contracts/protocol";
import {
  type AssetPathResolver,
  type ComponentRegistry,
  createAssetPathResolver,
  documentComponentRegistry,
} from "@meridian/markup";
import { AlertCircle, Image as ImageIcon, Loader2, RefreshCw } from "lucide-react";
import { type CSSProperties, createContext, type ReactNode, useContext, useMemo } from "react";
import type { Components } from "streamdown";

import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { Button } from "@/components/ui/button";
import { useAssetImageRenderState } from "@/core/editor/asset-image-render-state";
import { assetDocumentIdFromSrc } from "@/core/editor/image-workflow";

export type RegistryRenderPlanEntry = {
  componentName: string;
  tagName: string;
  kind: "container" | "leaf";
  allowedProps: string[];
};

/** Pure registry → renderer plan; Streamdown configuration is derived only from this list. */
export function registryRenderPlan(registry: ComponentRegistry): RegistryRenderPlanEntry[] {
  return Object.values(registry).map((spec) => ({
    componentName: spec.name,
    tagName: spec.name.toLowerCase(),
    kind: spec.kind,
    allowedProps: Object.keys(spec.props),
  }));
}

export function registryAllowedTags(
  plan: readonly RegistryRenderPlanEntry[],
): Record<string, string[]> {
  return Object.fromEntries(plan.map((entry) => [entry.tagName, entry.allowedProps]));
}

type AssetRenderContextValue = {
  projectId?: string;
  resolver: AssetPathResolver;
};

const emptyResolver = createAssetPathResolver([]);
const AssetRenderContext = createContext<AssetRenderContextValue>({ resolver: emptyResolver });

/**
 * Supplies a project asset namespace to every Markdown instance below it.
 * The manuscript tree is the same project-relative path index used by the editor.
 */
export function DocumentMarkdownProvider({
  projectId,
  children,
}: {
  projectId?: string | null;
  children: ReactNode;
}) {
  const { tree } = useProjectContextTree(projectId ?? "", "manuscript", {
    enabled: Boolean(projectId),
  });
  const resolver = useMemo(() => createAssetPathResolver(assetEntries(tree)), [tree]);
  const value = useMemo(
    () => ({ projectId: projectId ?? undefined, resolver }),
    [projectId, resolver],
  );
  return <AssetRenderContext.Provider value={value}>{children}</AssetRenderContext.Provider>;
}

function assetEntries(root: ProjectContextTreeNode | null): Array<readonly [string, string]> {
  if (!root) return [];
  if (root.kind === "file") {
    return !root.editable && root.fileType === "image"
      ? [[root.documentId, root.path.replace(/^\//, "")]]
      : [];
  }
  return root.children.flatMap(assetEntries);
}

type RegistryComponentProps = Record<string, unknown> & {
  children?: ReactNode;
};

function RegistryContainer({ children, align }: RegistryComponentProps) {
  const style: CSSProperties | undefined =
    align === "center" || align === "right" ? { textAlign: align } : undefined;
  return (
    <div data-registry-container style={style}>
      {children}
    </div>
  );
}

function FigureRenderer(props: RegistryComponentProps) {
  const src = textProp(props.src);
  const alt = textProp(props.alt);
  const label = textProp(props.label);
  const caption = textProp(props.caption);
  return (
    <figure className="my-4" data-registry-component="Figure">
      <RegistryImage src={src} alt={alt} />
      {label || caption ? (
        <figcaption>
          {label ? <span className="mr-2 font-medium">{label}</span> : null}
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function UnsupportedLeaf({
  componentName,
  props,
}: {
  componentName: string;
  props: RegistryComponentProps;
}) {
  const description = textProp(props.alt) || textProp(props.label) || componentName;
  if (props.children) return <>{props.children}</>;
  return (
    <span
      className="my-2 inline-flex items-center gap-2 rounded-md border border-border-subtle bg-card px-3 py-2 text-caption text-ink-muted"
      role="note"
    >
      <ImageIcon className="size-4" aria-hidden />
      {description}
    </span>
  );
}

function textProp(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const leafRenderers: Readonly<Record<string, (props: RegistryComponentProps) => ReactNode>> = {
  Figure: FigureRenderer,
};

function componentFor(entry: RegistryRenderPlanEntry): Components[string] {
  if (entry.kind === "container") return RegistryContainer;
  const LeafRenderer = leafRenderers[entry.componentName];
  if (LeafRenderer) return LeafRenderer;
  return (props: RegistryComponentProps) => (
    <UnsupportedLeaf componentName={entry.componentName} props={props} />
  );
}

export function registryComponents(plan: readonly RegistryRenderPlanEntry[]): Components {
  return Object.fromEntries(plan.map((entry) => [entry.tagName, componentFor(entry)]));
}

const renderPlan = registryRenderPlan(documentComponentRegistry);
export const documentMarkdownAllowedTags = registryAllowedTags(renderPlan);
export const documentMarkdownComponents = registryComponents(renderPlan);

export function resolveDocumentImageSource(
  src: string,
  resolver: AssetPathResolver,
): string | null {
  if (!src) return null;
  if (assetDocumentIdFromSrc(src)) return src;
  const assetDocumentId = resolver.assetForPath(src);
  if (assetDocumentId) return `asset:${assetDocumentId}`;
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(src)) return src;
  return null;
}

function RegistryImage({ src, alt }: { src: string; alt: string }) {
  const assets = useContext(AssetRenderContext);
  const resolvedSrc = resolveDocumentImageSource(src, assets.resolver);
  if (!resolvedSrc) return <BrokenImage alt={alt} />;
  return <ResolvedImage src={resolvedSrc} alt={alt} projectId={assets.projectId} />;
}

function ResolvedImage({ src, alt, projectId }: { src: string; alt: string; projectId?: string }) {
  const [state, actions] = useAssetImageRenderState({ projectId, src });
  if (state.kind === "ready") {
    return (
      <img
        className="max-w-full rounded-md"
        src={state.url}
        alt={alt}
        onError={assetDocumentIdFromSrc(src) ? actions.imageLoadFailed : undefined}
      />
    );
  }
  if (state.kind === "loading") {
    return (
      <span
        className="flex min-h-24 items-center justify-center gap-2 rounded-md border border-border-subtle bg-card text-caption text-ink-muted"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Loading image…</Trans>
      </span>
    );
  }
  return <BrokenImage alt={alt} message={state.message} onRetry={actions.retry} />;
}

function BrokenImage({
  alt,
  message,
  onRetry,
}: {
  alt: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <span
      className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-border-subtle bg-card px-3 py-4 text-center text-caption text-ink-muted"
      role="img"
      aria-label={alt || undefined}
    >
      <AlertCircle className="size-5" aria-hidden />
      <span>{alt || <Trans>Image unavailable</Trans>}</span>
      {message ? <span className="text-meta">{message}</span> : null}
      {onRetry ? (
        <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
          <RefreshCw className="size-3" aria-hidden />
          <Trans>Retry</Trans>
        </Button>
      ) : null}
    </span>
  );
}

export const documentMarkdownImageComponent: NonNullable<Components["img"]> = ({ src, alt }) => (
  <RegistryImage src={typeof src === "string" ? src : ""} alt={alt ?? ""} />
);
