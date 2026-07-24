/** Shared popup-window chrome and portal lifecycle for debug viewers. */
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";

export type DebugPopoutTarget = {
  popup: Window;
  container: HTMLDivElement;
};

export function openDebugPopoutWindow(options: {
  name: string;
  title: string;
  width?: number;
  height?: number;
}): DebugPopoutTarget | null {
  const popup = window.open(
    "",
    options.name,
    `popup,width=${options.width ?? 1440},height=${options.height ?? 900},resizable=yes,scrollbars=yes`,
  );
  if (!popup) return null;

  popup.document.open();
  popup.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="debug-popout-root"></div></body></html>',
  );
  popup.document.close();
  popup.document.title = options.title;

  copyDocumentAttributes(document.documentElement, popup.document.documentElement);
  copyDocumentAttributes(document.body, popup.document.body);
  for (const stylesheet of document.querySelectorAll('style, link[rel~="stylesheet"]')) {
    popup.document.head.append(stylesheet.cloneNode(true));
  }

  const container = popup.document.querySelector<HTMLDivElement>("#debug-popout-root");
  if (!container) {
    popup.close();
    return null;
  }

  popup.focus();
  return { popup, container };
}

function copyDocumentAttributes(source: HTMLElement, target: HTMLElement): void {
  for (const attribute of source.attributes) {
    target.setAttribute(attribute.name, attribute.value);
  }
}

export function DebugPopout({
  target,
  onClose,
  children,
}: {
  target: DebugPopoutTarget | null;
  onClose: (target: DebugPopoutTarget) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!target) return;

    const closePopup = () => target.popup.close();
    const handlePopupClose = () => onClose(target);
    target.popup.addEventListener("beforeunload", handlePopupClose);
    window.addEventListener("beforeunload", closePopup);
    const closedCheck = window.setInterval(() => {
      if (target.popup.closed) handlePopupClose();
    }, 500);

    return () => {
      target.popup.removeEventListener("beforeunload", handlePopupClose);
      window.removeEventListener("beforeunload", closePopup);
      window.clearInterval(closedCheck);
      if (!target.popup.closed) target.popup.close();
    };
  }, [onClose, target]);

  if (!target) return null;
  return createPortal(children, target.container);
}
