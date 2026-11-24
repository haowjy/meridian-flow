export const MAX_ORDERED_NUMBER = 999_999_999;

export type StepType = "quote" | "list";
export type ItemMarker = "item" | "todo" | "done";
export type ListKind = "bullet" | "ordered";

export type Step = { type: StepType; fresh: boolean };

export type ListFacts = {
  kind: ListKind;
  start: number;
  loose: boolean;
  items: number;
};

export type StepFacts = {
  type: StepType;
  opens: boolean;
  startsItem: boolean;
  list: ListFacts | null;
  number: number | null;
};

export type BlockFacts = {
  steps: StepFacts[];
  marker: ItemMarker | null;
};

export type NestingAttrs = Readonly<Record<string, unknown>>;
export type NestInput = { attrs: NestingAttrs; plainParagraph: boolean };

export function numberOf(start: number, index: number): number {
  return Math.min(start + index, MAX_ORDERED_NUMBER);
}

export function readPath(path: unknown): Step[] {
  if (typeof path !== "string") return [];
  const steps: Step[] = [];
  let fresh = false;
  for (const char of path) {
    if (char === "|") fresh = true;
    else if (char === ">" || char === "-") {
      steps.push({ type: char === ">" ? "quote" : "list", fresh });
      fresh = false;
    }
  }
  return steps;
}

export function pathOf(steps: readonly Step[]): string | null {
  if (steps.length === 0) return null;
  return steps
    .map((step) => (step.fresh ? "|" : "") + (step.type === "quote" ? ">" : "-"))
    .join("");
}

export function isNested(path: unknown): boolean {
  return readPath(path).length > 0;
}

export function isListed(path: unknown): boolean {
  return innermostListStep(readPath(path)) >= 0;
}

export function isBodyText(node: { type: { name: string }; attrs: NestingAttrs }): boolean {
  return node.type.name === "paragraph" && node.attrs.level == null && !isNested(node.attrs.path);
}

export function innermostListStep(steps: ReadonlyArray<{ type: StepType }>): number {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].type === "list") return i;
  return -1;
}

function readMarker(value: unknown): ItemMarker | null {
  return value === "item" || value === "todo" || value === "done" ? value : null;
}

function readStart(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_ORDERED_NUMBER
    ? value
    : 1;
}

type Open = { type: "quote" } | { type: "list"; list: ListFacts };

export function nest(blocks: Iterable<NestInput>): BlockFacts[] {
  const open: Open[] = [];
  const result: BlockFacts[] = [];
  for (const { attrs, plainParagraph } of blocks) {
    const steps = readPath(attrs.path);
    const marker = readMarker(attrs.marker);
    const kind: ListKind = attrs.kind === "ordered" ? "ordered" : "bullet";
    const loose = attrs.loose === true;
    const innermostList = innermostListStep(steps);

    let matched = 0;
    let continuesList = false;
    while (matched < steps.length && matched < open.length) {
      const step = steps[matched];
      const container = open[matched];
      if (step.fresh || container.type !== step.type) break;
      if (matched === innermostList && marker !== null) {
        continuesList = container.type === "list" && container.list.kind === kind;
        break;
      }
      matched++;
    }

    const facts: StepFacts[] = [];
    for (let i = 0; i < matched; i++) {
      const container = open[i];
      facts.push(
        container.type === "list"
          ? continued(container.list)
          : { type: "quote", opens: false, startsItem: false, list: null, number: null },
      );
    }
    if (continuesList) {
      const list = (open[matched] as { list: ListFacts }).list;
      list.items++;
      list.loose ||= loose;
      facts.push({
        type: "list",
        opens: false,
        startsItem: true,
        list,
        number: list.kind === "ordered" ? numberOf(list.start, list.items - 1) : null,
      });
      matched++;
    }
    open.length = matched;
    for (let i = matched; i < steps.length; i++) {
      if (steps[i].type === "quote") {
        open.push({ type: "quote" });
        facts.push({ type: "quote", opens: true, startsItem: false, list: null, number: null });
        continue;
      }
      const own = i === innermostList;
      const list: ListFacts = own
        ? {
            kind,
            start: kind === "ordered" ? readStart(attrs.start) : 1,
            loose,
            items: 1,
          }
        : { kind: "bullet", start: 1, loose: false, items: 1 };
      open.push({ type: "list", list });
      facts.push({
        type: "list",
        opens: true,
        startsItem: own,
        list,
        number: list.kind === "ordered" ? list.start : null,
      });
    }

    const own = innermostList < 0 ? null : facts[innermostList];
    let itemMarker: ItemMarker | null = null;
    if (own?.startsItem) {
      const lastIsList = innermostList === steps.length - 1;
      itemMarker =
        marker === "todo" || marker === "done"
          ? plainParagraph && lastIsList
            ? marker
            : "item"
          : "item";
    }
    result.push({ steps: facts, marker: itemMarker });
  }
  return result;
}

function continued(list: ListFacts): StepFacts {
  return {
    type: "list",
    opens: false,
    startsItem: false,
    list,
    number: list.kind === "ordered" ? numberOf(list.start, list.items - 1) : null,
  };
}

export function nestNodes(
  nodes: Iterable<{ type: { name: string }; attrs: NestingAttrs }>,
): BlockFacts[] {
  return nest(
    (function* () {
      for (const node of nodes) {
        yield {
          attrs: node.attrs,
          plainParagraph: node.type.name === "paragraph" && node.attrs.level == null,
        };
      }
    })(),
  );
}

export type NestedItem = {
  marker: ItemMarker | null;
  children: NestedNode[];
};
export type NestedNode =
  | { type: "block"; index: number }
  | { type: "quote"; children: NestedNode[] }
  | { type: "list"; list: ListFacts; items: NestedItem[] };

export function nestTree(facts: readonly BlockFacts[]): NestedNode[] {
  const root: NestedNode[] = [];
  const stack: Array<{ node: NestedNode; into: () => NestedNode[] }> = [];
  const containerOf = (node: NestedNode) => ({
    node,
    into: () =>
      node.type === "list"
        ? (node.items[node.items.length - 1] as NestedItem).children
        : node.type === "quote"
          ? node.children
          : [],
  });
  facts.forEach((block, index) => {
    block.steps.forEach((step, i) => {
      const parent = i === 0 ? root : stack[i - 1].into();
      if (step.opens) {
        stack.length = i;
        const node: NestedNode =
          step.type === "quote"
            ? { type: "quote", children: [] }
            : {
                type: "list",
                list: step.list as ListFacts,
                items: [{ marker: null, children: [] }],
              };
        parent.push(node);
        stack.push(containerOf(node));
      } else if (step.startsItem) {
        stack.length = i + 1;
        (stack[i].node as { items: NestedItem[] }).items.push({ marker: null, children: [] });
      }
    });
    stack.length = block.steps.length;
    const innermostList = innermostListStep(block.steps);
    if (block.marker !== null) {
      const list = stack[innermostList].node as { items: NestedItem[] };
      list.items[list.items.length - 1].marker = block.marker;
    }
    (stack.length === 0 ? root : stack[stack.length - 1].into()).push({ type: "block", index });
  });
  return root;
}

export function detach(paths: readonly (readonly Step[])[]): Step[][] {
  let cut = Number.POSITIVE_INFINITY;
  for (const steps of paths) cut = Math.min(cut, Math.max(0, innermostListStep(steps)));
  const detached = paths.map((steps) => steps.slice(Number.isFinite(cut) ? cut : 0));
  if (detached[0]) detached[0] = detached[0].map((step) => ({ ...step, fresh: false }));
  return detached;
}

export function landingBase(above: readonly Step[] | null, depth: number): Step[] {
  const aboveSteps = above ?? [];
  const aboveDepth = aboveSteps.filter((step) => step.type === "list").length;
  const levels = Math.min(depth, aboveDepth + 1) - 1;
  const base: Step[] = [];
  for (const step of aboveSteps) {
    if (base.filter((s) => s.type === "list").length >= levels) break;
    base.push({ type: step.type, fresh: false });
  }
  return base;
}

export function sharedSteps(facts: readonly BlockFacts[], from: number, to: number): number {
  let shared = facts[from]?.steps.length ?? 0;
  for (let i = from + 1; i < to; i++) {
    const steps = facts[i].steps;
    let k = 0;
    while (k < shared && k < steps.length && !steps[k].opens && !steps[k].startsItem) k++;
    shared = k;
  }
  return shared;
}

export function itemStart(facts: readonly BlockFacts[], index: number): number {
  const level = innermostListStep(facts[index].steps);
  let start = index;
  while (start > 0) {
    const step = facts[start].steps[level];
    if (!step || step.startsItem || step.opens) break;
    start--;
  }
  return start;
}

export function extentOf(facts: readonly BlockFacts[], index: number): [number, number] {
  const level = innermostListStep(facts[index].steps);
  if (level < 0 || !facts[index].steps[level].startsItem) return [index, index + 1];
  let end = index + 1;
  while (end < facts.length) {
    const step = facts[end].steps[level];
    if (step?.type !== "list" || step.opens || step.startsItem) break;
    end++;
  }
  return [index, end];
}
