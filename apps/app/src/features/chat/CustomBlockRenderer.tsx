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
import type { Block, TurnStatus } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import { useThreadStore } from "@/client/stores";
import { interruptResponseKey } from "@/core/session/interrupt-response";
import { componentBlockContent } from "./component-block-content";
import { COMPONENT_REGISTRY } from "./component-registry";
import { directResultForInvocation } from "./invocation-direct-result";

export type InterruptRespondRequest = {
  threadId: string;
  turnId: string;
  interruptId: string;
  value: JsonValue;
};

export type CustomBlockRendererProps = {
  block: Block;
  threadId: string;
  turnStatus?: TurnStatus;
  onRespondToInterrupt?: (request: InterruptRespondRequest) => void;
};

export function CustomBlockRenderer({
  block,
  threadId,
  turnStatus,
  onRespondToInterrupt,
}: CustomBlockRendererProps) {
  const content = componentBlockContent(block.content);
  const kind = content?.kind ?? null;
  const Component = kind ? COMPONENT_REGISTRY[kind] : undefined;
  const interruptId = content?.interrupt?.id ?? null;
  const responseEntry = useThreadStore((state) =>
    interruptId
      ? state.interruptResponses[
          interruptResponseKey({ threadId, turnId: block.turnId, interruptId })
        ]
      : undefined,
  );
  const turnBlocks = useThreadStore(
    (state) =>
      state.turnsByThread[threadId]?.find((turn) => turn.id === block.turnId)?.blocks ?? [],
  );

  if (!content || !Component) {
    return <UnknownComponentFallback block={block} kind={kind} />;
  }

  const hasResolvedValue = Object.hasOwn(content.props, "resolvedValue");
  const respond = (value: JsonValue) => {
    if (!interruptId) return;
    onRespondToInterrupt?.({
      threadId,
      turnId: block.turnId,
      interruptId,
      value,
    });
  };
  // Retry replays the exact submitted value with the same correlation tuple.
  const retry = () => {
    if (!interruptId || !responseEntry) return;
    onRespondToInterrupt?.({
      threadId,
      turnId: block.turnId,
      interruptId,
      value: responseEntry.value,
    });
  };

  return (
    <Component
      content={content}
      respond={respond}
      isAwaitingResponse={Boolean(
        interruptId && !hasResolvedValue && turnStatus === "waiting_interrupt",
      )}
      responseState={responseEntry ? { status: responseEntry.status } : null}
      retry={retry}
      invocationResult={
        kind === "helper-result" ? directResultForInvocation(turnBlocks, block) : undefined
      }
    />
  );
}

function UnknownComponentFallback({ block, kind }: { block: Block; kind: string | null }) {
  const kindLabel = kind ?? t`missing kind`;
  return (
    <div
      className="mb-4 rounded-lg border border-subtle bg-muted px-3 py-2 text-xs text-muted-foreground"
      data-block-id={block.id}
      data-block-type={block.blockType}
      data-block-seq={block.sequence}
      role="note"
    >
      <Trans>Unknown component: {kindLabel}</Trans>
    </div>
  );
}
