import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Copy, Ellipsis } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ChooserMark } from "@/components/ui/marks";
import { editorChromeAttributes } from "@/core/editor/chrome";
import {
  EditorMenu,
  useChromeSuppressed,
  useEditorChrome,
  useObjectOverlayCorner,
} from "@/features/editor/chrome";
import {
  FenceLanguageItems,
  FenceShapeItems,
  fenceLanguage,
  fenceLanguageLabel,
} from "./fence-menu-items";
import type { ObjectSurfaceTarget } from "./object-anchors";
import { copyText } from "./object-commands";
import type { RunVerb } from "./verb-feedback";

export type CodeBlockChipsProps = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  visible: boolean;
  onMenuOpenChange: (open: boolean) => void;
  run: RunVerb;
};

export function CodeBlockChips({
  editor,
  target,
  visible,
  onMenuOpenChange,
  run,
}: CodeBlockChipsProps) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const placement = useObjectOverlayCorner(editor, { inside: target.container });
  const [languageOpen, setLanguageOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    onMenuOpenChange(languageOpen || overflowOpen);
  }, [languageOpen, overflowOpen, onMenuOpenChange]);

  if (!placement || !chrome) return null;

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the mousedown only keeps the caret where it was; every control inside is a button
    <div
      className="meridian-object-overlay meridian-code-chips"
      data-code-chips=""
      data-state={visible && !suppressed ? "open" : "closed"}
      data-placement={placement.placement}
      contentEditable={false}
      {...editorChromeAttributes(chrome)}
      style={placement.style}
      onMouseDown={(event) => event.preventDefault()}
    >
      <EditorMenu
        editor={editor}
        id="code-language"
        open={languageOpen}
        onOpenChange={setLanguageOpen}
        align="end"
        trigger={
          <Button type="button" size="xs" variant="ghost" className="meridian-code-chip-language">
            {fenceLanguageLabel(fenceLanguage(target))}
            <ChooserMark />
          </Button>
        }
      >
        <FenceLanguageItems editor={editor} target={target} />
      </EditorMenu>

      <span className="meridian-code-chip-divider" aria-hidden />

      <IconButton
        type="button"
        size="xs"
        variant="ghost"
        label={t`Copy code`}
        onClick={() => run(copyText(target.node.textContent), "copy")}
      >
        <Copy aria-hidden />
      </IconButton>

      <EditorMenu
        editor={editor}
        id="code-overflow"
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        align="end"
        trigger={
          <IconButton type="button" size="xs" variant="ghost" label={t`More`}>
            <Ellipsis aria-hidden />
          </IconButton>
        }
      >
        <FenceShapeItems editor={editor} target={target} />
      </EditorMenu>
    </div>,
    placement.container,
  );
}
