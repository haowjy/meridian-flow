/**
 * CustomBlockRenderer — inline renderer for `blockType: "custom"` chat blocks.
 *
 * Purpose: Parses the custom block content, looks up `content.kind` in the
 * component registry, and mounts the registered component with the component
 * protocol props. Unknown or malformed content renders a visible placeholder
 * rather than falling through to the generic block-step renderer.
 * Key decision: components only call `respond(value)` with component-local data;
 * this renderer attaches the interrupt correlation tuple before handing the
 * message to the chat transport/controller layer.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { Block } from "@meridian/contracts/protocol";
import type { DirectInvocationResult } from "@meridian/thread-client";
import { componentBlockContent } from "@meridian/thread-client";
import { COMPONENT_REGISTRY } from "./component-registry";

export type CustomBlockRendererProps = {
  block: Block;
  threadId: string;
  directResult?: DirectInvocationResult | null;
};

export function CustomBlockRenderer({ block, threadId, directResult }: CustomBlockRendererProps) {
  const content = componentBlockContent(block.content);
  const kind = content?.kind ?? null;
  const Component = kind ? COMPONENT_REGISTRY[kind] : undefined;
  if (!content || !Component) return <UnknownComponentFallback block={block} kind={kind} />;
  return (
    <Component content={content} invocationResult={directResult ?? null} threadId={threadId} />
  );
}

function UnknownComponentFallback({ block, kind }: { block: Block; kind: string | null }) {
  const kindLabel = kind ?? t`missing kind`;
  return (
    <div
      className="chat-card [--chat-card-radius:var(--radius-lg)] [--chat-card-border:var(--color-border-subtle)] bg-muted text-xs text-muted-foreground"
      data-block-id={block.id}
      data-block-type={block.blockType}
      data-block-seq={block.sequence}
      role="note"
    >
      <Trans>Unknown component: {kindLabel}</Trans>
    </div>
  );
}
