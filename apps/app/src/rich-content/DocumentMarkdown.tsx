/** Settled Markdown: the canonical codec's document nodes rendered without an editor. */
import { t } from "@lingui/core/macro";
import { markdownCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { Check, Copy } from "lucide-react";
import { createElement, Fragment, type ReactNode, useMemo, useState } from "react";

const codec = markdownCodec({ schema: buildDocumentSchema() });
const lowlight = createLowlight(common);

type HighlightRoot = ReturnType<typeof lowlight.highlight>;
type HighlightNode = HighlightRoot | HighlightRoot["children"][number];

function highlighted(node: HighlightNode, key: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type === "root") return node.children.map(highlighted);
  if (node.type !== "element") return null;
  const element = node;
  return createElement(
    element.tagName,
    {
      key,
      className: Array.isArray(element.properties.className)
        ? element.properties.className.join(" ")
        : undefined,
    },
    element.children.map(highlighted),
  );
}

function CodeBlock({ node }: { node: PMNode }) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => {
    const language = node.attrs.language;
    if (language && !lowlight.registered(language)) return node.textContent;
    const tree = language
      ? lowlight.highlight(language, node.textContent)
      : lowlight.highlightAuto(node.textContent);
    return highlighted(tree, 0);
  }, [node]);
  return (
    <div className="document-code-block">
      <pre>
        <code className={node.attrs.language ? `language-${node.attrs.language}` : undefined}>
          {code}
        </code>
      </pre>
      <button
        type="button"
        className="document-code-copy focus-ring"
        aria-label={copied ? t`Copied` : t`Copy code`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(node.textContent);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        onBlur={() => setCopied(false)}
        onMouseLeave={() => setCopied(false)}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function children(node: PMNode, breaks: boolean): ReactNode[] {
  const result: ReactNode[] = [];
  node.forEach((child, _offset, index) => {
    result.push(<Fragment key={index}>{renderDocumentNode(child, breaks)}</Fragment>);
  });
  return result;
}

/** Markdown nodes only; MDX's figure/JSX nodes belong to its separate codec. */
export function renderDocumentNode(node: PMNode, breaks = false): ReactNode {
  if (node.isText) {
    let content: ReactNode = breaks
      ? node.text?.split("\n").map((line, index) => (
          <Fragment key={index}>
            {index > 0 && <br />}
            {line}
          </Fragment>
        ))
      : node.text;
    for (const mark of node.marks) {
      if (mark.type.name === "link") {
        // Never allow executable schemes into an anchor, including entity-decoded input.
        const href = /^(?:javascript|vbscript|data):/i.test(
          String(mark.attrs.href).replace(/\s/g, ""),
        )
          ? undefined
          : mark.attrs.href;
        content = (
          <a
            href={href}
            title={mark.attrs.title ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {content}
          </a>
        );
      } else {
        const tags: Record<string, string> = {
          strong: "strong",
          em: "em",
          code: "code",
          strike: "s",
        };
        const tag = tags[mark.type.name];
        if (!tag) throw new Error(`Unsupported document mark: ${mark.type.name}`);
        content = createElement(tag, null, content);
      }
    }
    return content;
  }
  const content = children(node, breaks);
  const alignment = node.attrs.align ? { textAlign: node.attrs.align } : undefined;
  switch (node.type.name) {
    case "doc":
      return content;
    case "paragraph":
      return <p style={alignment}>{content}</p>;
    case "heading":
      return createElement(`h${node.attrs.level}`, { style: alignment }, content);
    case "blockquote":
      return <blockquote>{content}</blockquote>;
    case "bullet_list":
      return <ul>{content}</ul>;
    case "ordered_list":
      return <ol start={node.attrs.order}>{content}</ol>;
    case "list_item":
      return (
        <li data-checked={node.attrs.checked === null ? undefined : String(node.attrs.checked)}>
          {content}
        </li>
      );
    case "hard_break":
      return <br />;
    case "horizontal_rule":
      return <hr />;
    case "code_block":
      return <CodeBlock node={node} />;
    case "image":
      return (
        <img
          src={node.attrs.src}
          alt={node.attrs.alt ?? ""}
          title={node.attrs.title ?? undefined}
          style={node.attrs.width ? { width: node.attrs.width } : undefined}
        />
      );
    case "table":
      return (
        <div className="tableWrapper">
          <table
            data-align={node.attrs.align ?? undefined}
            style={
              node.attrs.align
                ? { marginLeft: "auto", marginRight: node.attrs.align === "center" ? "auto" : 0 }
                : undefined
            }
          >
            <tbody>{content}</tbody>
          </table>
        </div>
      );
    case "table_row":
      return <tr>{content}</tr>;
    case "table_header":
    case "table_cell":
      return createElement(
        node.type.name === "table_header" ? "th" : "td",
        {
          colSpan: node.attrs.colspan,
          rowSpan: node.attrs.rowspan,
          style: node.attrs.alignment ? { textAlign: node.attrs.alignment } : undefined,
        },
        content,
      );
    default:
      throw new Error(`Unsupported Markdown node: ${node.type.name}`);
  }
}

export function DocumentMarkdown({
  source,
  breaks = false,
  className,
}: {
  source: string;
  breaks?: boolean;
  className?: string;
}) {
  const blocks = useMemo(() => codec.parse(source).blocks, [source]);
  return (
    <div className={className}>
      {blocks.map((node, index) => (
        <Fragment key={index}>{renderDocumentNode(node, breaks)}</Fragment>
      ))}
    </div>
  );
}
