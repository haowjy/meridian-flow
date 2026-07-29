/**
 * Mermaid rendering for `code_block` nodes whose language is `mermaid`.
 *
 * Rendering only: a mermaid fence renders as a diagram and never shows its
 * source in the page (interaction model §5.2). The source escape hatch belongs
 * to the diagram dialog the rebuild owns; the one fallback here is a parse
 * error, which reveals the fence so the writer can see what failed.
 */
import { t } from "@lingui/core/macro";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useState } from "react";

let mermaidModule: Promise<typeof import("mermaid")["default"]> | null = null;

export async function renderMermaid(id: string, source: string): Promise<string> {
  mermaidModule ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      // Mermaid may fetch authored external images before SVG sanitization (#7645).
      // Documents are author-controlled; resource CSP belongs to future app-wide policy.
    });
    return mermaid;
  });
  const mermaid = await mermaidModule;
  return (await mermaid.render(id, source)).svg;
}

function MermaidDiagram({ source, onError }: { source: string; onError(message: string): void }) {
  const reactId = useId();
  const [result, setResult] = useState<
    { status: "loading" } | { status: "ready"; svg: string } | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    setResult({ status: "loading" });

    const id = `meridian-mermaid-${reactId.replaceAll(":", "")}`;
    void renderMermaid(id, source)
      .then((svg) => {
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
  const isMermaid = props.node.attrs.language === "mermaid";
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => setRenderError(null), [props.node.textContent]);

  const showPreview = isMermaid && renderError === null;

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
      {showPreview ? (
        <div contentEditable={false} data-mermaid-preview="">
          <MermaidDiagram source={props.node.textContent} onError={setRenderError} />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
