import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Copy, ExternalLink, Pencil, Unlink } from "lucide-react";
import { useState } from "react";

import {
  canFollowLink,
  followLinkFrom,
  goneLinkDocumentId,
  type LinkMenuRequest,
  type LinkSurface,
  linkMenuRange,
  linkTargetLabel,
  openLinkForm,
  removeLinkAt,
  selectionCoversLink,
} from "@/core/editor/links";
import {
  EditorMenu,
  EditorMenuItem,
  EditorMenuLabel,
  EditorMenuSeparator,
  shortcutLabel,
} from "@/features/editor/chrome";
import {
  type ClipboardAvailability,
  clipboardAccess,
  writeClipboardRichText,
  writeClipboardText,
} from "@/features/editor/clipboard";

import { ClipboardMenuItems } from "../formatting";
import { useLinkResolution } from "./useLinkResolution";

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
  const resolution = useLinkResolution(editor, { ref: menu.ref, href: menu.href });
  const label =
    resolution?.state === "document"
      ? resolution.document.title
      : resolution?.state === "folder"
        ? resolution.folder.title
        : menu.target
          ? linkTargetLabel(menu.target)
          : menu.href;
  const followable =
    canFollowLink(menu.target, surface.navigator) &&
    (resolution?.state !== "gone" || Boolean(goneLinkDocumentId(resolution, { ref: menu.ref })));
  // A refusal is remembered for as long as this menu is open: the row greys
  // where the writer pressed it, in the same words the clipboard block below
  // uses. The next open asks the browser again, because capability can come
  // back — a permission granted, a tab that has focus this time.
  const [clipboard, setClipboard] = useState<ClipboardAvailability>(() => clipboardAccess().write);

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
      <EditorMenuLabel>{label}</EditorMenuLabel>
      {resolution?.state === "document" ? (
        <EditorMenuLabel className="pt-0">{resolution.document.path}</EditorMenuLabel>
      ) : null}
      {resolution?.state === "missing" ? (
        <EditorMenuLabel>{t`Doesn't exist yet`}</EditorMenuLabel>
      ) : null}
      {resolution?.state === "gone" ? (
        <EditorMenuLabel>{t`No longer available`}</EditorMenuLabel>
      ) : null}
      {followable ? (
        <EditorMenuItem
          onSelect={() => {
            followLinkFrom(editor, { ref: menu.ref, href: menu.href }, menu.at);
            close();
          }}
          note={shortcutLabel("Alt+Enter")}
        >
          <ExternalLink aria-hidden />
          {t`Open link`}
        </EditorMenuItem>
      ) : null}
      <EditorMenuItem
        blockedReason={clipboard === "available" ? null : t`Clipboard unavailable`}
        onSelect={(event) => {
          // The menu is the only thing on screen that can carry the answer, so
          // it stays open until the write settles and closes only on a copy
          // that happened. Closing on the press would report success by
          // disappearing, which is law 5's silent rejection with a smile.
          event.preventDefault();
          const range = linkMenuRange(menu);
          const internal = menu.target && menu.target.kind !== "external";
          const copied = internal
            ? editor.view.serializeForClipboard(editor.state.doc.slice(range.from, range.to))
            : null;
          const write = copied
            ? writeClipboardRichText(copied.dom.innerHTML, copied.text)
            : writeClipboardText(menu.href);
          void write.then((write) => {
            if (write.status === "done") close();
            else setClipboard("unavailable");
          });
        }}
      >
        <Copy aria-hidden />
        {menu.target && menu.target.kind !== "external" ? t`Copy reference` : t`Copy link address`}
      </EditorMenuItem>
      <EditorMenuItem
        onSelect={() => {
          // Selecting the link first is what makes the form's own resolution
          // land on it: one draft path serves Ctrl+K, the toolbar, and here.
          editor.commands.setTextSelection(linkMenuRange(menu));
          openLinkForm(editor);
        }}
        note={shortcutLabel("Mod+K")}
      >
        <Pencil aria-hidden />
        {t`Edit link`}
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
      <EditorMenuSeparator />
      <ClipboardMenuItems
        editor={editor}
        closeMenu={close}
        prepare={() => {
          if (selectionCoversLink(editor.state, linkMenuRange(menu))) return;
          editor.commands.setTextSelection(linkMenuRange(menu));
        }}
      />
    </EditorMenu>
  );
}
