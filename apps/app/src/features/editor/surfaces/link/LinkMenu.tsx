/**
 * The link's context menu — the primary link surface (§5.5, ruled).
 *
 * The editor claims the right-click on a link and nowhere else in prose, so
 * spellcheck keeps the native menu everywhere it matters. The claim already
 * happened in the kernel's ladder by the time this renders; what it owns is
 * the verbs.
 *
 * Every verb here acts on the range the pointer hit, never on the selection.
 * A writer right-clicks a link three paragraphs from the caret constantly, and
 * a menu that quietly edited the caret's link instead would be the worst kind
 * of correct.
 *
 * Open link is absent, not greyed, when nothing can follow the target (law 5:
 * absent beats disabled). That is the honest state for an internal link while
 * no navigator is registered, and for an href the classifier does not
 * recognize.
 */

import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Copy, ExternalLink, Pencil, Unlink } from "lucide-react";

import {
  canFollowLink,
  followLink,
  type LinkMenuRequest,
  type LinkSurface,
  linkMenuRange,
  openLinkForm,
  removeLinkAt,
} from "@/core/editor/links";
import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuSeparator,
  EditorMenuShortcut,
  shortcutLabel,
} from "@/features/editor/chrome";

export function LinkMenu({
  editor,
  surface,
  menu,
}: {
  editor: Editor;
  surface: LinkSurface;
  menu: LinkMenuRequest;
}) {
  const close = () => surface.closeMenu();
  const followable = canFollowLink(menu.target, surface.navigator);
  const copyable = typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText);

  return (
    <EditorMenu
      editor={editor}
      id="link-menu"
      // A menu summoned at a new point is a new menu: floating-ui never sees a
      // fixed anchor move, so the sequence keys the remount even when the
      // writer right-clicks the same pixel twice.
      key={menu.seq}
      at={menu.at}
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      {followable ? (
        <EditorMenuItem
          onSelect={() => {
            followLink({ target: menu.target, disposition: "current" }, surface.navigator);
            close();
          }}
        >
          <ExternalLink aria-hidden />
          {t`Open link`}
          <EditorMenuShortcut>{shortcutLabel("Alt+Enter")}</EditorMenuShortcut>
        </EditorMenuItem>
      ) : null}
      {copyable ? (
        <EditorMenuItem
          onSelect={() => {
            void navigator.clipboard.writeText(menu.href);
            close();
          }}
        >
          <Copy aria-hidden />
          {t`Copy link address`}
        </EditorMenuItem>
      ) : null}
      <EditorMenuItem
        onSelect={() => {
          // Selecting the link first is what makes the form's own resolution
          // land on it: one draft path serves Ctrl+K, the toolbar, and here.
          editor.commands.setTextSelection(linkMenuRange(menu));
          openLinkForm(editor);
        }}
      >
        <Pencil aria-hidden />
        {t`Edit link`}
        <EditorMenuShortcut>{shortcutLabel("Mod+K")}</EditorMenuShortcut>
      </EditorMenuItem>
      <EditorMenuSeparator />
      <EditorMenuItem
        onSelect={() => {
          removeLinkAt(editor, linkMenuRange(menu));
          close();
        }}
      >
        <Unlink aria-hidden />
        {t`Remove link`}
      </EditorMenuItem>
    </EditorMenu>
  );
}
