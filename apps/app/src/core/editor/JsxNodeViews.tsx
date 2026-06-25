/**
 * JsxNodeViews — minimal React NodeViews for MDX JSX blocks.
 *
 * Keeps `jsx_leaf` and `jsx_container` editable in TipTap while Session 3 owns
 * product-specific component rendering. Markdown/MDX serialization remains in
 * the shared codec; these views are only the in-editor presentation.
 */
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";

function displayName(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "Component";
}

export function JsxLeafNodeView(props: NodeViewProps) {
  const name = displayName(props.node.attrs.name);

  return (
    <NodeViewWrapper as="div" data-type="jsx_leaf" className="meridian-jsx-node">
      <span className="meridian-jsx-node__label" contentEditable={false}>
        {`<${name}>`}
      </span>
      <NodeViewContent className="meridian-jsx-node__content" />
      <span className="meridian-jsx-node__label" contentEditable={false}>
        {`</${name}>`}
      </span>
    </NodeViewWrapper>
  );
}

export function JsxContainerNodeView(props: NodeViewProps) {
  const name = displayName(props.node.attrs.name);

  return (
    <NodeViewWrapper as="div" data-type="jsx_container" className="meridian-jsx-node">
      <div className="meridian-jsx-node__label" contentEditable={false}>
        {`<${name}>`}
      </div>
      <NodeViewContent as="div" className="meridian-jsx-node__content" />
      <div className="meridian-jsx-node__label" contentEditable={false}>
        {`</${name}>`}
      </div>
    </NodeViewWrapper>
  );
}
