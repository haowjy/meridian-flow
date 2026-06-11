import Bold from "@tiptap/extension-bold";
import BulletList from "@tiptap/extension-bullet-list";
import Code from "@tiptap/extension-code";
import CodeBlock from "@tiptap/extension-code-block";
import HardBreak from "@tiptap/extension-hard-break";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import ListItem from "@tiptap/extension-list-item";
import OrderedList from "@tiptap/extension-ordered-list";

export const MeridianStrong = Bold.extend({ name: "strong" });
export const MeridianEm = Italic.extend({ name: "em" });
export const MeridianCode = Code.extend({ name: "code" });
export const MeridianHardBreak = HardBreak.extend({ name: "hard_break" });
export const MeridianListItem = ListItem.extend({ name: "list_item" });
export const MeridianCodeBlock = CodeBlock.extend({ name: "code_block" });

export const MeridianLink = Link.extend({
  inclusive: false,
  addAttributes() {
    return {
      href: { default: "" },
      title: { default: null },
    };
  },
});

export const MeridianBulletList = BulletList.extend({
  name: "bullet_list",
  content: "list_item+",
  group: "block",
  addAttributes() {
    return { tight: { default: false } };
  },
});

export const MeridianOrderedList = OrderedList.extend({
  name: "ordered_list",
  content: "list_item+",
  group: "block",
  addAttributes() {
    return {
      order: { default: 1 },
      tight: { default: false },
    };
  },
});
