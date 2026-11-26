import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import {
  Code2,
  Copy,
  CopyPlus,
  Download,
  ImageDown,
  ImageUp,
  Maximize2,
  Scaling,
  Trash2,
  Type,
} from "lucide-react";
import type { ReactNode } from "react";

import { holdNode } from "@/core/editor/anchors";
import { diagramProviderFor } from "@/core/editor/diagrams";
import {
  imageReplaceTarget,
  imageWidthAttr,
  openImagePicker,
  setImageWidth,
} from "@/core/editor/images";
import { type ObjectSurfaceField, objectSurfaceFields } from "@/core/editor/objects";
import {
  EditorMenuItem,
  EditorMenuSeparator,
  type OverlayIconRowItem,
} from "@/features/editor/chrome";

import { type ObjectSurfaceTarget, renderedImage } from "./object-anchors";
import {
  copyImageFrom,
  copySvgImage,
  copyText,
  deleteObject,
  downloadImageFrom,
  downloadPng,
  duplicateObject,
  fenceSource,
  renderedDiagramSvg,
} from "./object-commands";
import type { RunVerb } from "./verb-feedback";

export const DIAGRAM_EXPORT_FILENAME = "diagram.png";

export type ObjectVerbContext = {
  editor: Editor;
  target: ObjectSurfaceTarget;
  run: RunVerb;
  openLightbox: (pos: number, withSource?: boolean) => boolean;
  openField: (pos: number, field: ObjectSurfaceField) => void;
};

export function objectFieldLabel(field: ObjectSurfaceField): string {
  switch (field) {
    case "alt":
      return t`Alt text`;
    case "caption":
      return t`Caption`;
    case "label":
      return t`Label`;
  }
}

export function objectRowItems({
  editor,
  target,
  run,
  openLightbox,
}: ObjectVerbContext): OverlayIconRowItem[] {
  const provider = diagramProviderFor(target.node);
  const copyItem: OverlayIconRowItem = provider
    ? {
        id: "copy",
        label: t`Copy ${provider.name} source`,
        icon: <Copy aria-hidden />,
        onSelect: () => run(copyText(fenceSource(editor, target.pos)), "copy"),
      }
    : {
        id: "copy",
        label: t`Copy image`,
        icon: <Copy aria-hidden />,
        onSelect: () => run(copyImageFrom(imageSource(target)), "copy"),
      };

  return [
    {
      id: "fullscreen",
      label: t`Open full screen`,
      icon: <Maximize2 aria-hidden />,
      onSelect: () => openLightbox(target.pos),
    },
    copyItem,
  ];
}

export function ObjectMenuItems(context: ObjectVerbContext): ReactNode {
  const { editor, target, run, openLightbox, openField } = context;
  const provider = diagramProviderFor(target.node);
  const svg = provider ? renderedDiagramSvg(target.element) : null;
  const source = provider ? "" : imageSource(target);
  const fields = objectSurfaceFields(target.node);

  return (
    <>
      {provider ? (
        <EditorMenuItem onSelect={() => openLightbox(target.pos, true)}>
          <Code2 aria-hidden />
          {t`Edit source`}
        </EditorMenuItem>
      ) : null}

      {fields.map((field) => (
        <EditorMenuItem key={field} onSelect={() => openField(target.pos, field)}>
          <Type aria-hidden />
          {objectFieldLabel(field)}
        </EditorMenuItem>
      ))}

      {fields.length > 0 ? (
        <EditorMenuItem
          onSelect={() => openImagePicker(editor, imageReplaceTarget(editor, target.pos))}
        >
          <ImageUp aria-hidden />
          {t`Replace image`}
        </EditorMenuItem>
      ) : null}

      {svg ? (
        <EditorMenuItem onSelect={() => run(copySvgImage(svg), "copy")}>
          <ImageDown aria-hidden />
          {t`Copy image`}
        </EditorMenuItem>
      ) : null}
      {svg ? (
        <EditorMenuItem onSelect={() => run(downloadPng(svg, DIAGRAM_EXPORT_FILENAME), "download")}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}
      {source ? (
        <EditorMenuItem onSelect={() => run(downloadImageFrom(source), "download")}>
          <Download aria-hidden />
          {t`Download image`}
        </EditorMenuItem>
      ) : null}

      {imageWidthAttr(target.node.attrs) === null ? null : (
        <EditorMenuItem
          onSelect={() => {
            const hold = holdNode(editor.state, target.pos);
            if (hold) setImageWidth(editor, hold, null);
          }}
        >
          <Scaling aria-hidden />
          {t`Reset size`}
        </EditorMenuItem>
      )}

      <EditorMenuSeparator />
      <EditorMenuItem onSelect={() => duplicateObject(editor, target.pos)}>
        <CopyPlus aria-hidden />
        {t`Duplicate`}
      </EditorMenuItem>
      <EditorMenuItem variant="destructive" onSelect={() => deleteObject(editor, target.pos)}>
        <Trash2 aria-hidden />
        {t`Delete`}
      </EditorMenuItem>
    </>
  );
}

function imageSource(target: ObjectSurfaceTarget): string {
  const image = renderedImage(target.element);
  return image?.currentSrc || image?.src || "";
}
