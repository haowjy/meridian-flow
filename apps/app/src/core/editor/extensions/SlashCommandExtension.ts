/** Slash-command insertion menu for empty manuscript paragraphs. */
import { Extension, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

export type SlashCommandId =
  | "scene-break"
  | "heading"
  | "quote"
  | "bullet-list"
  | "numbered-list"
  | "table"
  | "image"
  | "code"
  | "diagram";

export type SlashCommandItem = {
  id: SlashCommandId;
  label: string;
  aliases: readonly string[];
};

export type SlashCommandExtensionOptions = {
  items: readonly SlashCommandItem[];
  menuLabel: string;
  requestImageUpload?: () => void;
};

export const slashCommandPluginKey = new PluginKey("slashCommand");

function fuzzyScore(value: string, query: string): number | null {
  const candidate = value.toLocaleLowerCase();
  if (candidate.startsWith(query)) return 0;
  if (candidate.split(/\s+/u).some((word) => word.startsWith(query))) return 1;

  let queryIndex = 0;
  for (const character of candidate) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return 2;
  }
  return null;
}

/** Fuzzy label + alias filtering; stable ties preserve the writer-first catalog order. */
export function filterSlashCommandItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...items];

  return items
    .map((item, order) => ({
      item,
      order,
      score: Math.min(
        ...[item.label, ...item.aliases].map(
          (value) => fuzzyScore(value, normalizedQuery) ?? Number.POSITIVE_INFINITY,
        ),
      ),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .map(({ item }) => item);
}

function runSlashCommand(
  editor: SuggestionProps<SlashCommandItem, SlashCommandItem>["editor"],
  range: Range,
  item: SlashCommandItem,
  requestImageUpload?: () => void,
) {
  const chain = editor.chain().focus().deleteRange(range);
  switch (item.id) {
    case "scene-break":
      chain.setHorizontalRule().run();
      return;
    case "heading":
      chain.setHeading({ level: 1 }).run();
      return;
    case "quote":
      chain.toggleBlockquote().run();
      return;
    case "bullet-list":
      chain.toggleBulletList().run();
      return;
    case "numbered-list":
      chain.toggleOrderedList().run();
      return;
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      return;
    case "image":
      chain.run();
      requestImageUpload?.();
      return;
    case "code":
      chain.setCodeBlock().run();
      return;
    case "diagram":
      chain.setCodeBlock({ language: "mermaid" }).run();
  }
}

function createMenuRenderer(menuLabel: string) {
  let element: HTMLDivElement | null = null;
  let unmount: (() => void) | null = null;
  let props: SuggestionProps<SlashCommandItem, SlashCommandItem> | null = null;
  let selectedIndex = 0;

  const paint = () => {
    if (!element || !props) return;
    if (selectedIndex >= props.items.length) selectedIndex = Math.max(0, props.items.length - 1);
    element.replaceChildren();
    for (const [index, item] of props.items.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "meridian-slash-menu__item";
      button.role = "option";
      button.ariaSelected = String(index === selectedIndex);
      button.textContent = item.label;
      button.addEventListener("mouseenter", () => {
        selectedIndex = index;
        paint();
      });
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => props?.command(item));
      element.append(button);
    }
  };

  return {
    onStart(nextProps: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      props = nextProps;
      selectedIndex = 0;
      element = document.createElement("div");
      element.className = "meridian-slash-menu";
      element.role = "listbox";
      element.ariaLabel = menuLabel;
      paint();
      unmount = nextProps.mount(element);
    },
    onUpdate(nextProps: SuggestionProps<SlashCommandItem, SlashCommandItem>) {
      props = nextProps;
      selectedIndex = 0;
      paint();
    },
    onKeyDown({
      event,
      view,
    }: {
      event: KeyboardEvent;
      view: Parameters<typeof exitSuggestion>[0];
    }) {
      if (event.key === "Escape") {
        exitSuggestion(view, slashCommandPluginKey);
        return true;
      }
      if (!props?.items.length) return false;
      if (event.key === "ArrowUp") {
        selectedIndex = (selectedIndex + props.items.length - 1) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "ArrowDown") {
        selectedIndex = (selectedIndex + 1) % props.items.length;
        paint();
        return true;
      }
      if (event.key === "Enter") {
        const item = props.items[selectedIndex];
        if (item) props.command(item);
        return true;
      }
      return false;
    },
    onExit() {
      unmount?.();
      unmount = null;
      element = null;
      props = null;
    },
  };
}

export const SlashCommandExtension = Extension.create<SlashCommandExtensionOptions>({
  name: "slashCommand",

  addOptions() {
    return { items: [], menuLabel: "", requestImageUpload: undefined };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem, SlashCommandItem>({
        editor: this.editor,
        pluginKey: slashCommandPluginKey,
        char: "/",
        startOfLine: true,
        allowedPrefixes: null,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if (
            $from.parent.type.name !== "paragraph" ||
            range.from !== $from.start() ||
            $from.parent.content.size !== range.to - range.from
          ) {
            return false;
          }
          for (let depth = $from.depth - 1; depth > 0; depth -= 1) {
            const role = $from.node(depth).type.spec.tableRole;
            if (role === "cell" || role === "header_cell") return false;
          }
          return true;
        },
        items: ({ query }) => filterSlashCommandItems(this.options.items, query),
        command: ({ editor, range, props }) =>
          runSlashCommand(editor, range, props, this.options.requestImageUpload),
        render: () => createMenuRenderer(this.options.menuLabel),
      }),
    ];
  },
});
