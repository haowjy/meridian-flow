/**
 * The link lane's one entry in the chrome host: the hint, the menu, and the
 * form, all reading the same store.
 *
 * Three components rather than one because they have three different physics.
 * The hint is approach chrome and fades; the menu and the form are summoned
 * surfaces that claim a layer in the Esc chain. The store keeps them from
 * disagreeing: opening either surface clears the hint, and opening one clears
 * the other (law 4).
 */

import type { Editor } from "@tiptap/core";

import { LinkForm } from "./LinkForm";
import { LinkHint } from "./LinkHint";
import { LinkMenu } from "./LinkMenu";
import { useLinkSurface, useLinkSurfaceState } from "./useLinkSurface";

export function LinkSurfaces({ editor }: { editor: Editor }) {
  const surface = useLinkSurface(editor);
  const { hint, menu, form } = useLinkSurfaceState(editor);
  if (!surface) return null;

  return (
    <>
      <LinkHint editor={editor} hint={hint} />
      {menu ? <LinkMenu editor={editor} surface={surface} menu={menu} /> : null}
      {form ? <LinkForm editor={editor} surface={surface} form={form} /> : null}
    </>
  );
}
