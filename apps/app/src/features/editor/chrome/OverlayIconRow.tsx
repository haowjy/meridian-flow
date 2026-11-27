import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { Ellipsis } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";

import { editorChromeAttributes } from "@/core/editor/chrome";

import { type ObjectOverlayCorner, useObjectOverlayCorner } from "./object-overlay";
import { useChromeSuppressed, useEditorChrome } from "./useEditorChrome";
import "./overlay-icon-row.css";

export type OverlayIconRowItem = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

export type OverlayIconRowProps = {
  editor: Editor | null;
  corner: ObjectOverlayCorner | null;
  visible: boolean;
  items: readonly OverlayIconRowItem[];
  overflow?: (chip: ReactNode) => ReactNode;
  kind: string;
};

export function OverlayIconRow({
  editor,
  corner,
  visible,
  items,
  overflow,
  kind,
}: OverlayIconRowProps) {
  const chrome = useEditorChrome(editor);
  const suppressed = useChromeSuppressed(editor);
  const placement = useObjectOverlayCorner(editor, corner);

  if (!placement || !chrome) return null;

  const chromeAttributes = editorChromeAttributes(chrome);

  return createPortal(
    <TooltipProvider delayDuration={400}>
      <div
        data-overlay-icon-row={kind}
        {...chromeAttributes}
        data-state={visible && !suppressed ? "open" : "closed"}
        data-placement={placement.placement}
        className="meridian-object-overlay meridian-overlay-icon-row"
        style={placement.style}
        contentEditable={false}
      >
        {items.map((item) => (
          <OverlayIconChip
            key={item.id}
            label={item.label}
            onSelect={item.onSelect}
            chromeAttributes={chromeAttributes}
          >
            {item.icon}
          </OverlayIconChip>
        ))}
        {overflow?.(
          <OverlayIconChip label={t`More`} asTrigger chromeAttributes={chromeAttributes}>
            <Ellipsis aria-hidden />
          </OverlayIconChip>,
        )}
      </div>
    </TooltipProvider>,
    placement.container,
  );
}

function OverlayIconChip({
  label,
  onSelect,
  asTrigger = false,
  chromeAttributes,
  onMouseDown,
  children,
  ...rest
}: ComponentProps<"button"> & {
  label: string;
  onSelect?: () => void;
  asTrigger?: boolean;
  chromeAttributes: Record<string, string>;
  children: ReactNode;
}) {
  // The rest props are the menu's: a lane hands this chip to Radix as its trigger,
  // and Radix opens on the `onPointerDown` it injects here. Dropping them leaves a ⋯
  // that cannot be pressed.
  return (
    <IconButton
      {...rest}
      type="button"
      variant="ghost"
      size="xs"
      label={label}
      tooltipSide="top"
      tooltipContentProps={chromeAttributes}
      className="meridian-overlay-icon-chip"
      onClick={asTrigger ? rest.onClick : onSelect}
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
    >
      {children}
    </IconButton>
  );
}
