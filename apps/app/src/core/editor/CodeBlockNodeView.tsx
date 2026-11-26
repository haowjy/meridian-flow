import type { Editor, NodeViewProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import { useCallback, useSyncExternalStore } from "react";

import {
  DiagramBody,
  type DiagramProvider,
  diagramProviderFor,
  useDiagramRender,
} from "./diagrams";
import { caretInsideNodeAt, engageObject, selectObjectTransaction } from "./objects";

function useCaretInsideNode(editor: Editor, getPos: () => number | undefined): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      editor.on("transaction", onStoreChange);
      editor.on("focus", onStoreChange);
      editor.on("blur", onStoreChange);
      return () => {
        editor.off("transaction", onStoreChange);
        editor.off("focus", onStoreChange);
        editor.off("blur", onStoreChange);
      };
    },
    [editor],
  );
  const read = () => {
    const pos = getPos();
    return pos !== undefined && caretInsideNodeAt(editor.state, editor.isFocused, pos);
  };
  return useSyncExternalStore(subscribe, read, read);
}

export function CodeBlockNodeView(props: NodeViewProps) {
  const provider = diagramProviderFor(props.node);
  const caretInside = useCaretInsideNode(props.editor, props.getPos);
  const showSource = !provider || caretInside;

  return (
    <NodeViewWrapper
      className={provider ? "meridian-diagram-block" : undefined}
      data-language={String(props.node.attrs.language ?? "")}
    >
      {/* The content host. First child, unconditional, and never keyed off the
          selection: ProseMirror owns this text, and a node view that moved it
          would move the caret with it. `white-space: inherit` hands the wrap
          decision back to the `<pre>`, whose CSS the chip cluster's Wrap lines
          toggles; TipTap's own default (`pre-wrap`, inline) makes that control
          a no-op. */}
      <pre className={showSource ? undefined : "hidden"}>
        <NodeViewContent as={"code" as never} style={{ whiteSpace: "inherit" }} />
      </pre>
      {/* The render layer. Mounted for the whole life of a diagram fence: the
          condition is the language attr, which only a document change moves, so
          no selection transition adds or removes this element. Everything
          inside it changes on the parser's clock instead.

          Keyed by provider, because the render layer holds one provider's render
          state: a language change swaps which renderer is called, and reusing
          the component across that swap would hand the new provider the old
          one's hook state. A language change is a document change, so a remount
          here is allowed where a selection-driven one would not be. */}
      {provider ? (
        <div className={showSource ? "hidden" : undefined} contentEditable={false}>
          <DiagramRenderLayer
            key={provider.language}
            editor={props.editor}
            getPos={props.getPos}
            provider={provider}
            source={props.node.textContent}
          />
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}

function DiagramRenderLayer({
  editor,
  getPos,
  provider,
  source,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  provider: DiagramProvider;
  source: string;
}) {
  const render = useDiagramRender(provider, source);

  const openSource = () => {
    const pos = getPos();
    const node = pos === undefined ? null : editor.state.doc.nodeAt(pos);
    if (pos === undefined || !node) return;
    // Select first: engaging leaves the diagram selected underneath, so closing
    // the dialog lands on it rather than wherever the caret was.
    const selected = selectObjectTransaction(editor.state, pos);
    if (selected) editor.view.dispatch(selected);
    engageObject(editor, { node, pos }, "engage");
  };

  return (
    <DiagramBody
      render={render}
      describesSource={render.rendered === source}
      onEditSource={openSource}
    />
  );
}
