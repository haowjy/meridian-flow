import type { Editor } from "@tiptap/core";

import { FolderLinkMenu } from "./FolderLinkMenu";
import { LinkForm } from "./LinkForm";
import { LinkHint } from "./LinkHint";
import { LinkMenu } from "./LinkMenu";
import { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";
import "./link-surfaces.css";

export function LinkSurfaces({ editor }: { editor: Editor }) {
  const surface = useLinkSurface(editor);
  const { hint, menu, form, folder } = useLinkSurfaceState(editor);
  if (!surface) return null;

  return (
    <>
      <LinkHint editor={editor} hint={hint} />
      {menu ? <LinkMenu editor={editor} surface={surface} menu={menu} /> : null}
      {form ? <LinkForm editor={editor} surface={surface} form={form} /> : null}
      {folder ? <FolderLinkMenu editor={editor} surface={surface} folder={folder} /> : null}
    </>
  );
}
