/** Bubble registration and controls for a selected inline image. */
import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ImageUp, Trash2 } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type BubbleContext, type BubbleMatch, useEditorBubble } from "./EditorBubbleHost";

type ImageData = { src: string; alt: string };
export type ImageUploader = (file: File) => Promise<{ src: string; alt: string }>;

export function matchSelectedImage(editor: Editor): BubbleMatch | null {
  const selection = editor.state.selection;
  if (
    !editor.isEditable ||
    !(selection instanceof NodeSelection) ||
    selection.node.type.name !== "image"
  )
    return null;
  return {
    from: selection.from,
    to: selection.to,
    nodePos: selection.from,
    identity: selection.node,
    data: {
      src: String(selection.node.attrs.src ?? ""),
      alt: String(selection.node.attrs.alt ?? ""),
    } satisfies ImageData,
  };
}

export function createImageBubbleContext(upload: ImageUploader): BubbleContext {
  return {
    id: "image",
    anchor: "node-top",
    accessibleName: () => t`Image controls`,
    match: matchSelectedImage,
    Component: (props) => <ImageBubble {...props} upload={upload} />,
  };
}

function ImageBubble({
  editor,
  match,
  upload,
}: {
  editor: Editor;
  match: BubbleMatch;
  upload: ImageUploader;
}) {
  const data = match.data as ImageData;
  const [src, setSrc] = useState(data.src);
  const [alt, setAlt] = useState(data.alt);
  const [uploading, setUploading] = useState(false);
  const inputId = useId();
  const altInputId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const { close } = useEditorBubble();

  const update = (attrs: ImageData) => {
    const pos = match.nodePos;
    if (pos === undefined) return;
    const node = editor.state.doc.nodeAt(pos);
    if (node?.type.name !== "image") return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }),
    );
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextSrc = src.trim();
    if (!nextSrc) return;
    update({ src: nextSrc, alt: alt.trim() });
    close({ focusEditor: true });
  };

  const remove = () => {
    if (match.nodePos !== undefined)
      editor.commands.deleteRange({ from: match.nodePos, to: match.nodePos + 1 });
    close({ focusEditor: true });
  };

  return (
    <form className="flex w-96 items-end gap-1.5 p-2" onSubmit={submit}>
      <label className="min-w-0 flex-1" htmlFor={inputId}>
        <span className="visually-hidden">{t`Image URL`}</span>
        <Input
          id={inputId}
          data-bubble-autofocus
          value={src}
          onChange={(event) => setSrc(event.target.value)}
          placeholder={t`Image URL`}
          className="h-8"
        />
      </label>
      <label className="min-w-0 flex-1" htmlFor={altInputId}>
        <span className="visually-hidden">{t`Alt text`}</span>
        <Input
          id={altInputId}
          value={alt}
          onChange={(event) => setAlt(event.target.value)}
          placeholder={t`Alt text`}
          className="h-8"
        />
      </label>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setUploading(true);
          try {
            const replacement = await upload(file);
            update(replacement);
            close({ focusEditor: true });
          } catch {
            // The shared upload coordinator presents the localized failure receipt.
          } finally {
            setUploading(false);
          }
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={uploading}
        aria-label={t`Replace image`}
        onClick={() => fileRef.current?.click()}
      >
        <ImageUp className="size-3.5" aria-hidden />
      </Button>
      <Button type="submit" size="sm">{t`Update image`}</Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={t`Remove image`}
        onClick={remove}
      >
        <Trash2 className="size-3.5" aria-hidden />
      </Button>
    </form>
  );
}
