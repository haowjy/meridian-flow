import type { Node as PMNode } from "prosemirror-model";
import {
  type MdastList,
  type MdastListItem,
  parseBlockChildren,
  pmBlockChildrenToMdast,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec, ParseContext, SerializeContext } from "../../types.js";

export const bulletListCodec: BlockCodec<MdastList> = {
  name: "bullet_list",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "list",
      ordered: false,
      spread: !node.attrs.tight,
      children: listItemsToMdast(node, ctx),
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "list" || ast.ordered) return null;
    return ctx.schema.node(
      "bullet_list",
      { tight: !ast.spread },
      ast.children.map((child) => listItemToPm(child, ctx)),
    );
  },
};

export const orderedListCodec: BlockCodec<MdastList> = {
  name: "ordered_list",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "list",
      ordered: true,
      start: node.attrs.order ?? 1,
      spread: !node.attrs.tight,
      children: listItemsToMdast(node, ctx),
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "list" || !ast.ordered) return null;
    return ctx.schema.node(
      "ordered_list",
      { order: ast.start ?? 1, tight: !ast.spread },
      ast.children.map((child) => listItemToPm(child, ctx)),
    );
  },
};

export const listItemCodec: BlockCodec<MdastListItem> = {
  name: "list_item",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "list",
      ordered: false,
      spread: false,
      children: [listItemToMdast(node, ctx)],
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "listItem") return null;
    return listItemToPm(ast, ctx);
  },
};

function listItemsToMdast(node: PMNode, ctx: SerializeContext): MdastListItem[] {
  const items: MdastListItem[] = [];
  node.forEach((child) => {
    items.push(listItemToMdast(child, ctx));
  });
  return items;
}

function listItemToMdast(node: PMNode, ctx: SerializeContext): MdastListItem {
  return { type: "listItem", spread: false, children: pmBlockChildrenToMdast(node, ctx) };
}

function listItemToPm(node: MdastListItem, ctx: ParseContext): PMNode {
  const children = parseBlockChildren(node.children, ctx);
  if (children[0]?.type.name !== "paragraph") {
    return ctx.schema.node("list_item", null, [ctx.schema.node("paragraph"), ...children]);
  }
  return ctx.schema.node("list_item", null, children);
}
