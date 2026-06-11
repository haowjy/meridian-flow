import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { EditorOptions, Extensions } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import {
  MeridianBulletList,
  MeridianCode,
  MeridianCodeBlock,
  MeridianEm,
  MeridianHardBreak,
  MeridianLink,
  MeridianListItem,
  MeridianOrderedList,
  MeridianStrong,
} from "./meridian-extensions";

export type CreateEditorExtensionsOptions = {
  document: Y.Doc;
  awareness: Awareness;
};

export function createEditorExtensions({ document }: CreateEditorExtensionsOptions): Extensions {
  return [
    StarterKit.configure({
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      hardBreak: false,
      history: false,
      horizontalRule: false,
      italic: false,
      listItem: false,
      orderedList: false,
      strike: false,
    }),
    MeridianStrong,
    MeridianEm,
    MeridianCode,
    MeridianLink,
    MeridianBulletList,
    MeridianOrderedList,
    MeridianListItem,
    MeridianHardBreak,
    MeridianCodeBlock,
    Collaboration.configure({
      document,
      fragment: document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    }),
  ];
}

export function createEditorConfig(
  options: CreateEditorExtensionsOptions & {
    editable?: boolean;
    editorProps?: EditorOptions["editorProps"];
  },
): Partial<EditorOptions> {
  return {
    extensions: createEditorExtensions(options),
    editable: options.editable ?? true,
    editorProps: options.editorProps,
  };
}
