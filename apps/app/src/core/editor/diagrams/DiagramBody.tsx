import { t } from "@lingui/core/macro";
import { Code2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import { type DiagramRender, diagramFace } from "./diagram-render-state";

export const DIAGRAM_PREVIEW_SELECTOR = "[data-diagram-preview]";

export function DiagramBody({
  render,
  describesSource,
  onEditSource,
  sourceActionLabel = t`Edit source`,
}: {
  render: DiagramRender;
  describesSource: boolean;
  onEditSource: () => void;
  sourceActionLabel?: string;
}) {
  const face = diagramFace(render);

  if (face === "pending") {
    return (
      <div className="px-4 py-6 text-center text-muted-foreground text-sm" role="status">
        {t`Rendering diagram…`}
      </div>
    );
  }

  if (face === "unrendered") {
    return (
      <DiagramErrorCard
        message={render.error}
        onEditSource={onEditSource}
        sourceActionLabel={sourceActionLabel}
      />
    );
  }

  return (
    <>
      {face === "stale" && describesSource ? (
        <p className="meridian-diagram-parse-note mb-2" role="status">
          {t`Syntax error`}
          <code>{render.error}</code>
        </p>
      ) : null}
      <div
        className="meridian-diagram"
        data-diagram-preview=""
        dangerouslySetInnerHTML={{ __html: render.svg ?? "" }}
      />
    </>
  );
}

function DiagramErrorCard({
  message,
  onEditSource,
  sourceActionLabel,
}: {
  message: string | null;
  onEditSource: () => void;
  sourceActionLabel: string;
}) {
  return (
    <div className="meridian-diagram-error" role="status">
      <div className="meridian-diagram-error-head">
        <p className="meridian-diagram-error-title">{t`This diagram has a syntax problem`}</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          // A press here must not carry a caret into the fence underneath.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onEditSource}
        >
          <Code2 aria-hidden />
          {sourceActionLabel}
        </Button>
      </div>
      {message ? <code className="meridian-diagram-error-message">{message}</code> : null}
    </div>
  );
}
