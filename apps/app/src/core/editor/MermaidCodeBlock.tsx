/** Mermaid preview state and the code-block NodeView that consumes it. */
import { t } from "@lingui/core/macro";
import type { Editor, NodeViewProps } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useEffect, useId, useState } from "react";

type CodeBlockViewState = {
  previewPosition: number | null;
  encounteredLanguages: ReadonlyMap<number, readonly string[]>;
};

type CodeBlockViewMeta = { previewPosition: number | null };

export const mermaidPreviewKey = new PluginKey<CodeBlockViewState>("mermaidPreview");

function collectCodeBlockLanguages(
  doc: ProseMirrorNode,
  previous: ReadonlyMap<number, readonly string[]> = new Map(),
): ReadonlyMap<number, readonly string[]> {
  const encountered = new Map(previous);
  doc.descendants((node, pos) => {
    if (node.type.name !== "code_block") return;
    const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
    if (!language) return;
    const languages = encountered.get(pos) ?? [];
    if (!languages.includes(language)) encountered.set(pos, [...languages, language]);
  });
  return encountered;
}

export function createMermaidPreviewPlugin(): Plugin<CodeBlockViewState> {
  return new Plugin<CodeBlockViewState>({
    key: mermaidPreviewKey,
    state: {
      init: (_, state) => ({
        previewPosition: null,
        encounteredLanguages: collectCodeBlockLanguages(state.doc),
      }),
      apply(transaction, state) {
        const meta = transaction.getMeta(mermaidPreviewKey) as CodeBlockViewMeta | undefined;
        const mappedPreview =
          state.previewPosition === null
            ? null
            : transaction.mapping.mapResult(state.previewPosition);
        const mappedLanguages = new Map<number, readonly string[]>();
        for (const [position, languages] of state.encounteredLanguages) {
          const mapped = transaction.mapping.mapResult(position);
          if (transaction.doc.nodeAt(mapped.pos)?.type.name === "code_block") {
            mappedLanguages.set(mapped.pos, languages);
          }
        }
        return {
          previewPosition:
            meta !== undefined
              ? meta.previewPosition
              : mappedPreview === null || mappedPreview.deleted
                ? null
                : mappedPreview.pos,
          encounteredLanguages: collectCodeBlockLanguages(transaction.doc, mappedLanguages),
        };
      },
    },
  });
}

export function isMermaidPreviewRequested(editor: Editor, nodePos: number): boolean {
  return mermaidPreviewKey.getState(editor.state)?.previewPosition === nodePos;
}

export function codeBlockLanguagesEncountered(editor: Editor, nodePos: number): readonly string[] {
  return mermaidPreviewKey.getState(editor.state)?.encounteredLanguages.get(nodePos) ?? [];
}

export function setMermaidPreviewRequested(
  editor: Editor,
  nodePos: number,
  requested: boolean,
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(mermaidPreviewKey, {
      previewPosition: requested ? nodePos : null,
    } satisfies CodeBlockViewMeta),
  );
}

export function enterMermaidEditMode(editor: Editor, nodePos: number): void {
  const node = editor.state.doc.nodeAt(nodePos);
  if (node?.type.name !== "code_block") return;
  const transaction = editor.state.tr
    .setMeta(mermaidPreviewKey, { previewPosition: null } satisfies CodeBlockViewMeta)
    .setSelection(TextSelection.create(editor.state.doc, nodePos + 1));
  editor.view.dispatch(transaction);
  editor.commands.focus(undefined, { scrollIntoView: false });
}

function selectionIsInsideNode(props: NodeViewProps): boolean {
  const position = props.getPos();
  if (position === undefined) return false;
  const { from, to } = props.editor.state.selection;
  return (
    (from >= position + 1 && to <= position + props.node.nodeSize - 1) ||
    (from === position && to === position + props.node.nodeSize)
  );
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
  const previewVisible = usePreviewVisibility(props);
  const isMermaid = props.node.attrs.language === "mermaid";
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => setRenderError(null), [props.node.textContent]);

  const showPreview = previewVisible && renderError === null;
  const enterEditMode = (event: { preventDefault(): void }) => {
    event.preventDefault();
    const position = props.getPos();
    if (position !== undefined) enterMermaidEditMode(props.editor, position);
  };

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
        <button
          type="button"
          className="block w-full text-inherit"
          contentEditable={false}
          data-mermaid-preview=""
          aria-label={t`Edit diagram`}
          onFocus={enterEditMode}
          onPointerDown={enterEditMode}
        >
          <MermaidDiagram source={props.node.textContent} onError={setRenderError} />
        </button>
      ) : null}
    </NodeViewWrapper>
  );
}
