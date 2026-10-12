/** Static and streaming Markdown: the canonical codec's document nodes rendered without an editor. */
import { markdownCodec, type PresentationSourceRun } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { createElement, Fragment, memo, type ReactNode, useMemo } from "react";
import remend from "remend";

import { classifyLinkTarget } from "@/core/editor/links";
import { DocumentCodeBlock } from "./DocumentCodeBlock";
import { createDocumentCache } from "./document-cache";
import { splitMarkdownBlocks } from "./markdown-blocks";
import {
  boundedRanges,
  type MarkdownReferenceOccurrence,
  type MarkdownSkillOccurrence,
  referenceForRun,
  skillsForRuns,
} from "./reference-occurrences";
import { SkillToken } from "./SkillToken";
import { TranscriptReference } from "./TranscriptReference";

const codec = markdownCodec({ schema: buildDocumentSchema() });
const settledBlocks = createDocumentCache<PMNode[]>();

type Presentation = {
  source: string;
  runs: ReadonlyMap<string, PresentationSourceRun[]>;
  references: readonly MarkdownReferenceOccurrence[];
  skills: readonly MarkdownSkillOccurrence[];
};
const runKey = (kind: string, path: readonly number[]) => `${kind}:${path.join("/")}`;

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
  throttle: boolean,
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
          {renderDocumentNode(child, breaks, throttle, presentation, [...path, index], openCode)}
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
            throttle,
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
  throttle = false,
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
  const content = children(node, breaks, throttle, presentation, path, openCode);
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
      return <DocumentCodeBlock node={node} throttle={throttle} diagrams={node !== openCode} />;
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

// Source strings, not PM nodes, are the memo boundary: settled blocks never parse
// or highlight again as their tail grows. Fragments keep all DOM blocks siblings.
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  breaks,
  repair,
  throttle,
  openFence,
}: {
  source: string;
  breaks: boolean;
  repair: boolean;
  throttle: boolean;
  openFence: boolean;
}) {
  const blocks = useMemo(
    () =>
      repair
        ? codec.parse(remend(source, { links: false, images: false, katex: false })).blocks
        : settledBlocks(source, () => codec.parse(source).blocks),
    [source, repair],
  );
  const openCode = openFence ? lastCodeBlock(blocks) : null;
  return blocks.map((node, index) => (
    <Fragment key={index}>
      {renderDocumentNode(node, breaks, throttle, undefined, [], openCode)}
    </Fragment>
  ));
});

function StaticTranscript({
  source,
  breaks,
  openFence,
  references,
  skills,
}: {
  source: string;
  breaks: boolean;
  references: readonly MarkdownReferenceOccurrence[];
  skills: readonly MarkdownSkillOccurrence[];
  openFence: boolean;
}) {
  const { blocks, sourceMap } = useMemo(() => codec.parseWithSourceMap(source), [source]);
  const presentation = useMemo(() => {
    const runs = new Map<string, PresentationSourceRun[]>();
    for (const run of sourceMap) {
      const key = runKey(run.kind, [run.at.block, ...run.at.path]);
      runs.set(key, [...(runs.get(key) ?? []), run]);
    }
    return {
      source,
      runs,
      references: boundedRanges(references, source.length),
      skills: boundedRanges(skills, source.length),
    };
  }, [source, sourceMap, references, skills]);
  const openCode = openFence ? lastCodeBlock(blocks) : null;
  return blocks.map((node, index) => (
    <Fragment key={index}>
      {renderDocumentNode(node, breaks, false, presentation, [index], openCode)}
    </Fragment>
  ));
}

export function DocumentMarkdown({
  source,
  breaks = false,
  streaming = false,
  className,
  references = [],
  skills = [],
}: {
  source: string;
  breaks?: boolean;
  streaming?: boolean;
  className?: string;
  references?: readonly MarkdownReferenceOccurrence[];
  skills?: readonly MarkdownSkillOccurrence[];
}) {
  const { blocks, openFence } = useMemo(() => splitMarkdownBlocks(source), [source]);
  return (
    <div className={className}>
      {!streaming && (references.length > 0 || skills.length > 0) ? (
        <StaticTranscript
          openFence={openFence}
          source={source}
          breaks={breaks}
          references={references}
          skills={skills}
        />
      ) : (
        blocks.map((block, index) => (
          <MarkdownBlock
            key={index}
            source={block}
            breaks={breaks}
            repair={streaming && index === blocks.length - 1}
            throttle={streaming && openFence && index === blocks.length - 1}
            openFence={openFence && index === blocks.length - 1}
          />
        ))
      )}
    </div>
  );
}
