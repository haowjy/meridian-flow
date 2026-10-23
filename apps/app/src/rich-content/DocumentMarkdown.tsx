/** Static and streaming Markdown: the canonical codec's document nodes rendered without an editor. */
import { markdownCodec, type PresentationSourceRun } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import {
  createElement,
  Fragment,
  memo,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import { browserPictureSource } from "@/core/editor/images";
import { classifyLinkTarget } from "@/core/editor/links";
import { DocumentCodeBlock } from "./DocumentCodeBlock";
import { createDocumentCache } from "./document-cache";
import { splitMarkdownBlocks } from "./markdown-blocks";
import {
  configureMarkdownStreaming,
  releaseStreamingMarkdown,
  requestStreamingMarkdown,
  type StreamingMarkdownSnapshot,
  settledStreamingMarkdown,
  streamingMarkdownSnapshot,
  subscribeStreamingMarkdown,
} from "./markdown-stream-service";
import {
  boundedRanges,
  type MarkdownReferenceOccurrence,
  type MarkdownSkillOccurrence,
  referenceForRun,
  skillsForRuns,
} from "./reference-occurrences";
import { SkillToken } from "./SkillToken";
import { TranscriptReference } from "./TranscriptReference";

const schema = buildDocumentSchema();
const codec = markdownCodec({ schema });
configureMarkdownStreaming(schema, (source) => codec.parseStreaming(source, { repair: true }));
const settledSnapshots = createDocumentCache<StreamingMarkdownSnapshot>();
const settledBlocks = createDocumentCache<PMNode[]>();

type Presentation = {
  source: string;
  runs: ReadonlyMap<string, PresentationSourceRun[]>;
  references: readonly MarkdownReferenceOccurrence[];
  skills: readonly MarkdownSkillOccurrence[];
};
const runKey = (kind: string, path: readonly number[]) => `${kind}:${path.join("/")}`;

function ownsNode(block: PMNode, target: PMNode | null): boolean {
  if (!target) return false;
  if (block === target) return true;
  let found = false;
  block.descendants((node) => {
    if (node === target) found = true;
    return !found;
  });
  return found;
}

function lastCodeBlock(blocks: readonly PMNode[]): PMNode | null {
  let last: PMNode | null = null;
  for (const block of blocks) {
    if (block.type.name === "code_block") last = block;
    block.descendants((node) => {
      if (node.type.name === "code_block") last = node;
      return node.type.name !== "code_block";
    });
  }
  return last;
}

function parseSettled(source: string): StreamingMarkdownSnapshot {
  const split = splitMarkdownBlocks(source);
  const blocks = split.blocks.flatMap((block) =>
    settledBlocks(block, () => codec.parse(block).blocks),
  );
  const openCode = split.openFence ? lastCodeBlock(blocks) : null;
  return {
    source,
    blocks,
    openCode,
    openCodeBlock: blocks.findIndex((block) => ownsNode(block, openCode)),
  };
}

function renderLink(mark: PMMark, content: ReactNode): ReactNode {
  const target = classifyLinkTarget(String(mark.attrs.href));
  if (target?.kind === "external") {
    return (
      <a
        href={target.url}
        data-link-kind="external"
        title={mark.attrs.title ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
      >
        {content}
      </a>
    );
  }
  if (target) {
    return <TranscriptReference data-target-href={mark.attrs.href}>{content}</TranscriptReference>;
  }
  return content;
}

function children(
  node: PMNode,
  breaks: boolean,
  presentation?: Presentation,
  path: number[] = [],
  openCode: PMNode | null = null,
): ReactNode[] {
  const result: ReactNode[] = [];
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    const link = child.marks.find((mark) => mark.type.name === "link");
    if (!link) {
      result.push(
        <Fragment key={index}>
          {renderDocumentNode(child, breaks, presentation, [...path, index], openCode)}
        </Fragment>,
      );
      continue;
    }
    const key = index;
    const run = presentation?.runs.get(runKey("link", [...path, key]));
    const reference = presentation && referenceForRun(run?.[0], presentation.references);
    const labelPresentation =
      reference && presentation ? { ...presentation, skills: [] } : presentation;
    const label: ReactNode[] = [];
    // A mixed-format label is one chip (and one outbound arrow), like the Editor.
    for (; index < node.childCount; index++) {
      const part = node.child(index);
      if (!part.marks.some((mark) => mark.eq(link))) break;
      label.push(
        <Fragment key={index}>
          {renderDocumentNode(
            part.mark(part.marks.filter((mark) => mark.type.name !== "link")),
            breaks,
            labelPresentation,
            [...path, index],
            openCode,
          )}
        </Fragment>,
      );
    }
    index--;
    const hasSkills =
      presentation &&
      Array.from(
        { length: index - key + 1 },
        (_, offset) =>
          skillsForRuns(
            presentation.runs.get(runKey("text", [...path, key + offset])),
            presentation.source,
            presentation.skills,
          ).length > 0,
      ).some(Boolean);
    result.push(
      <Fragment key={key}>
        {reference ? (
          <TranscriptReference
            data-document-id={reference.documentId}
            data-uri={reference.uri}
            data-authored-label="true"
          >
            {label}
          </TranscriptReference>
        ) : hasSkills ? (
          label
        ) : (
          renderLink(link, label)
        )}
      </Fragment>,
    );
  }
  return result;
}

/** Markdown nodes only; MDX's figure/JSX nodes belong to its separate codec. */
function renderDocumentNode(
  node: PMNode,
  breaks = false,
  presentation?: Presentation,
  path: number[] = [],
  openCode: PMNode | null = null,
): ReactNode {
  if (node.isText) {
    const skills =
      presentation && !node.marks.some((mark) => mark.type.name === "code")
        ? skillsForRuns(
            presentation.runs.get(runKey("text", path)),
            presentation.source,
            presentation.skills,
          )
        : [];
    const text = (value: string): ReactNode =>
      breaks
        ? value.split(/\r?\n|\r/).map((line, index) => (
            <Fragment key={index}>
              {index > 0 && <br />}
              {line}
            </Fragment>
          ))
        : value;
    let cursor = 0;
    const parts: ReactNode[] = [];
    for (const { from, to, skill } of skills) {
      parts.push(
        <Fragment key={`text-${from}`}>{text((node.text ?? "").slice(cursor, from))}</Fragment>,
      );
      parts.push(<SkillToken key={`skill-${from}`} {...skill} />);
      cursor = to;
    }
    parts.push(<Fragment key="tail">{text((node.text ?? "").slice(cursor))}</Fragment>);
    let content: ReactNode = parts;
    for (const mark of node.marks) {
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
    return content;
  }
  const content = children(node, breaks, presentation, path, openCode);
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
      return (
        <DocumentCodeBlock node={node} throttle={node === openCode} diagrams={node !== openCode} />
      );
    case "image": {
      const src = browserPictureSource(String(node.attrs.src));
      if (!src) return node.attrs.alt ?? "";
      return (
        <img
          src={src}
          alt={node.attrs.alt ?? ""}
          title={node.attrs.title ?? undefined}
          style={node.attrs.width ? { width: node.attrs.width } : undefined}
        />
      );
    }
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

const MarkdownBlock = memo(function MarkdownBlock({
  node,
  breaks,
  openCode,
}: {
  node: PMNode;
  breaks: boolean;
  openCode: PMNode | null;
}) {
  return renderDocumentNode(node, breaks, undefined, [], openCode);
});

const MarkdownBlocks = memo(function MarkdownBlocks({
  snapshot,
  breaks,
}: {
  snapshot: StreamingMarkdownSnapshot | null;
  breaks: boolean;
}) {
  if (!snapshot) return null;
  return snapshot.blocks.map((node, index) => (
    <MarkdownBlock
      key={index}
      node={node}
      breaks={breaks}
      openCode={index === snapshot.openCodeBlock ? snapshot.openCode : null}
    />
  ));
});

function StaticTranscript({
  source,
  breaks,
  references,
  skills,
  streamId,
}: {
  source: string;
  breaks: boolean;
  references: readonly MarkdownReferenceOccurrence[];
  skills: readonly MarkdownSkillOccurrence[];
  streamId?: string;
}) {
  const parsed = useMemo(() => codec.parseWithSourceMap(source), [source]);
  const snapshot = streamId ? settledStreamingMarkdown(streamId, source) : null;
  const settled = reuseEqualSnapshot(
    {
      source,
      blocks: parsed.blocks,
      openCode: parsed.openCode,
      openCodeBlock: parsed.blocks.findIndex((block) => ownsNode(block, parsed.openCode)),
    },
    snapshot,
  );
  const presentation = useMemo(() => {
    const runs = new Map<string, PresentationSourceRun[]>();
    for (const run of parsed.sourceMap) {
      const key = runKey(run.kind, [run.at.block, ...run.at.path]);
      runs.set(key, [...(runs.get(key) ?? []), run]);
    }
    return {
      source,
      runs,
      references: boundedRanges(references, source.length),
      skills: boundedRanges(skills, source.length),
    };
  }, [source, parsed.sourceMap, references, skills]);
  return settled.blocks.map((node, index) => (
    <Fragment key={index}>
      {renderDocumentNode(
        node,
        breaks,
        presentation,
        [index],
        index === settled.openCodeBlock ? settled.openCode : null,
      )}
    </Fragment>
  ));
}

export function DocumentMarkdown({
  source,
  breaks = false,
  streaming = false,
  streamId,
  className,
  references = [],
  skills = [],
}: {
  source: string;
  breaks?: boolean;
  streaming?: boolean;
  streamId?: string;
  className?: string;
  references?: readonly MarkdownReferenceOccurrence[];
  skills?: readonly MarkdownSkillOccurrence[];
}) {
  const live = useStreamingMarkdown(streamId, source, streaming);
  const hasPresentation = !streaming && (references.length > 0 || skills.length > 0);
  const settled = useMemo(() => {
    if (streaming || hasPresentation) return null;
    const parsed = settledSnapshots(source, () => parseSettled(source));
    const previous = streamId ? settledStreamingMarkdown(streamId, source) : null;
    return reuseEqualSnapshot(parsed, previous);
  }, [hasPresentation, source, streamId, streaming]);
  const snapshot = streaming ? live : settled;
  return (
    <div
      className={className}
      data-markdown-source-length={snapshot?.source.length ?? (streaming ? -1 : source.length)}
    >
      {hasPresentation ? (
        <StaticTranscript
          source={source}
          breaks={breaks}
          references={references}
          skills={skills}
          streamId={streamId}
        />
      ) : (
        <MarkdownBlocks snapshot={snapshot} breaks={breaks} />
      )}
    </div>
  );
}

function useStreamingMarkdown(
  streamId: string | undefined,
  source: string,
  active: boolean,
): StreamingMarkdownSnapshot | null {
  const [snapshot, setSnapshot] = useState<StreamingMarkdownSnapshot | null>(() =>
    streamId ? streamingMarkdownSnapshot(streamId) : null,
  );
  useLayoutEffect(() => {
    if (!active || !streamId) return;
    const update = () => setSnapshot(streamingMarkdownSnapshot(streamId));
    const unsubscribe = subscribeStreamingMarkdown(streamId, update);
    update();
    return () => {
      unsubscribe();
      releaseStreamingMarkdown(streamId);
    };
  }, [active, streamId]);
  useLayoutEffect(() => {
    if (active && streamId) requestStreamingMarkdown(streamId, source);
  }, [active, source, streamId]);
  return snapshot;
}

function reuseEqualSnapshot(
  next: StreamingMarkdownSnapshot,
  previous: StreamingMarkdownSnapshot | null,
): StreamingMarkdownSnapshot {
  if (!previous) return next;
  const blocks = next.blocks.map((node, index) => {
    const old = previous.blocks[index];
    return old?.eq(node) ? old : node;
  });
  const openCode =
    next.openCode && next.openCodeBlock >= 0
      ? nodeAtPath(
          blocks[next.openCodeBlock],
          nodePath(next.blocks[next.openCodeBlock], next.openCode),
        )
      : null;
  return { ...next, blocks, openCode };
}

function nodePath(node: PMNode | undefined, target: PMNode): number[] | null {
  if (!node) return null;
  if (node === target) return [];
  for (let index = 0; index < node.childCount; index++) {
    const path = nodePath(node.child(index), target);
    if (path) return [index, ...path];
  }
  return null;
}

function nodeAtPath(node: PMNode | undefined, path: readonly number[] | null): PMNode | null {
  if (!node || !path) return null;
  let current = node;
  for (const index of path) {
    const child = current.maybeChild(index);
    if (!child) return null;
    current = child;
  }
  return current;
}
