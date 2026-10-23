/** Shared transcript code highlighting, hover copy and the Editor's diagram render boundary. */
import { t } from "@lingui/core/macro";
import type { Node as PMNode } from "@tiptap/pm/model";
import { common, createLowlight } from "lowlight";
import { Check, Copy } from "lucide-react";
import { createElement, memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  DiagramBody,
  type DiagramProvider,
  diagramProviderFor,
  useDiagramRender,
} from "@/core/editor/diagrams";
import { createDocumentCache } from "./document-cache";

const lowlight = createLowlight(common);
const settledCode = createDocumentCache<ReactNode>();

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

const DiagramBlock = memo(
  function DiagramBlock({ node, provider }: { node: PMNode; provider: DiagramProvider }) {
    const render = useDiagramRender(provider, node.textContent);
    const [showSource, setShowSource] = useState(false);
    if (showSource) return <CodeBlock node={node} />;
    return (
      <div className="document-diagram">
        <DiagramBody
          render={render}
          describesSource={render.rendered === node.textContent}
          onEditSource={() => setShowSource(true)}
          sourceActionLabel={t`Show source`}
        />
      </div>
    );
  },
  (previous, next) => previous.provider === next.provider && previous.node.eq(next.node),
);

function CodeBlock({ node, throttle = false }: { node: PMNode; throttle?: boolean }) {
  const [copied, setCopied] = useState(false);
  const source = node.textContent;
  const language = node.attrs.language as string | null;
  const [snapshot, setSnapshot] = useState({ source, language });
  const lastHighlight = useRef(0);
  useEffect(() => {
    if (!throttle || (snapshot.source === source && snapshot.language === language)) return;
    if (!lastHighlight.current) lastHighlight.current = performance.now();
    const timer = setTimeout(
      () => {
        lastHighlight.current = performance.now();
        setSnapshot({ source, language });
      },
      Math.max(0, 50 - (performance.now() - lastHighlight.current)),
    );
    return () => clearTimeout(timer);
  }, [source, language, throttle, snapshot]);
  const highlightSource = throttle ? snapshot.source : source;
  const highlightLanguage = throttle ? snapshot.language : language;
  const code = useMemo(() => {
    const compute = () => {
      const language = highlightLanguage;
      if (language && !lowlight.registered(language)) return highlightSource;
      const tree = language
        ? lowlight.highlight(language, highlightSource)
        : lowlight.highlightAuto(highlightSource);
      if (tree.children.length === 0 && highlightSource.length > 0) return highlightSource;
      return highlighted(tree, 0);
    };
    return throttle
      ? compute()
      : settledCode(JSON.stringify([highlightLanguage, highlightSource]), compute);
  }, [highlightSource, highlightLanguage, throttle]);
  return (
    <div className="document-code-block">
      <pre>
        <code className={node.attrs.language ? `language-${node.attrs.language}` : undefined}>
          {source.startsWith(highlightSource) && language === highlightLanguage ? (
            <>
              {code}
              {source.slice(highlightSource.length)}
            </>
          ) : (
            source
          )}
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

export function DocumentCodeBlock({
  node,
  throttle,
  diagrams,
}: {
  node: PMNode;
  throttle: boolean;
  diagrams: boolean;
}) {
  const provider = diagrams && diagramProviderFor(node);
  return provider ? (
    <DiagramBlock key={provider.language} node={node} provider={provider} />
  ) : (
    <CodeBlock node={node} throttle={throttle} />
  );
}
