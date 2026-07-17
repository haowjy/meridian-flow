/** Mermaid preview state and the code-block NodeView that consumes it. */
import { t } from "@lingui/core/macro";
import type { Editor, NodeViewProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useState } from "react";

export const mermaidPreviewKey = new PluginKey<number | null>("mermaidPreview");

export function createMermaidPreviewPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: mermaidPreviewKey,
    state: {
      init: (): number | null => null,
      apply(transaction, position) {
        const requested = transaction.getMeta(mermaidPreviewKey) as number | null | undefined;
        if (requested !== undefined) return requested;
        if (position === null) return null;
        const mapped = transaction.mapping.mapResult(position);
        return mapped.deleted ? null : mapped.pos;
      },
    },
  });
}

export function isMermaidPreviewRequested(editor: Editor, nodePos: number): boolean {
  return mermaidPreviewKey.getState(editor.state) === nodePos;
}

export function setMermaidPreviewRequested(
  editor: Editor,
  nodePos: number,
  requested: boolean,
): void {
  editor.view.dispatch(editor.state.tr.setMeta(mermaidPreviewKey, requested ? nodePos : null));
}

function selectionIsInsideNode(props: NodeViewProps): boolean {
  const position = props.getPos();
  if (position === undefined) return false;
  const { from, to } = props.editor.state.selection;
  return from >= position + 1 && to <= position + props.node.nodeSize - 1;
}

function usePreviewVisibility(props: NodeViewProps): boolean {
  const calculate = () => {
    if (props.node.attrs.language !== "mermaid") return false;
    const position = props.getPos();
    if (position === undefined) return false;
    return isMermaidPreviewRequested(props.editor, position) || !selectionIsInsideNode(props);
  };
  const [visible, setVisible] = useState(calculate);

  useEffect(() => {
    const update = () => setVisible(calculate());
    props.editor.on("transaction", update);
    update();
    return () => {
      props.editor.off("transaction", update);
    };
  });

  return visible;
}

function MermaidDiagram({ source, onError }: { source: string; onError(message: string): void }) {
  const reactId = useId();
  const [result, setResult] = useState<
    { status: "loading" } | { status: "ready"; svg: string } | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    setResult({ status: "loading" });

    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const id = `meridian-mermaid-${reactId.replaceAll(":", "")}`;
        const { svg } = await mermaid.render(id, source);
        if (active) setResult({ status: "ready", svg });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : t`Unable to render diagram`;
        setResult({ status: "error", message });
        onError(message);
      });

    return () => {
      active = false;
    };
  }, [onError, reactId, source]);

  if (result.status === "loading") {
    return (
      <div className="px-4 py-6 text-center text-muted-foreground text-sm" role="status">
        {t`Rendering diagram…`}
      </div>
    );
  }
  if (result.status === "error") {
    return (
      <div className="m-3 rounded-md bg-destructive/10 p-3 text-destructive text-sm" role="alert">
        <p className="font-medium">{t`Diagram could not be rendered`}</p>
        <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{result.message}</p>
      </div>
    );
  }

  return (
    <div
      className="overflow-auto p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
      // Mermaid's strict security mode sanitizes authored labels before producing the SVG.
      dangerouslySetInnerHTML={{ __html: result.svg }}
    />
  );
}

export function MermaidCodeBlockNodeView(props: NodeViewProps) {
  const previewVisible = usePreviewVisibility(props);
  const isMermaid = props.node.attrs.language === "mermaid";
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => setRenderError(null), [props.node.textContent]);

  const showPreview = previewVisible && renderError === null;

  return (
    <NodeViewWrapper data-language={String(props.node.attrs.language ?? "")}>
      {isMermaid && renderError ? (
        <div
          className="mb-2 rounded-md bg-destructive/10 p-3 text-destructive text-sm"
          contentEditable={false}
          role="alert"
        >
          <p className="font-medium">{t`Diagram could not be rendered`}</p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs">{renderError}</p>
        </div>
      ) : null}
      <pre className={showPreview ? "hidden" : undefined}>
        <NodeViewContent as={"code" as never} />
      </pre>
      {isMermaid && showPreview ? (
        <div contentEditable={false} data-mermaid-preview="">
          <MermaidDiagram source={props.node.textContent} onError={setRenderError} />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
