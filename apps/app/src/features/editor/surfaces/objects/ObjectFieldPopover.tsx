import { t } from "@lingui/core/macro";
import type { Editor } from "@tiptap/core";
import { useCallback, useId } from "react";

import { type ObjectSurfaceField, objectSurfaceFields } from "@/core/editor/objects";
import { EditorPopover } from "@/features/editor/chrome";

import type { ObjectSurfaceTarget } from "./object-anchors";
import { setObjectField } from "./object-commands";
import { objectFieldLabel } from "./object-menu-items";

export type ObjectFieldPopoverProps = {
  editor: Editor;
  target: ObjectSurfaceTarget | null;
  field: ObjectSurfaceField;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ObjectFieldPopover({
  editor,
  target,
  field,
  open,
  onOpenChange,
}: ObjectFieldPopoverProps) {
  const fields = target ? objectSurfaceFields(target.node) : [];

  return (
    <EditorPopover
      editor={editor}
      id="object-fields"
      open={open}
      onOpenChange={onOpenChange}
      anchorRect={() => target?.element.getBoundingClientRect() ?? null}
      side="bottom"
      align="end"
      className="meridian-object-fields"
      focusOnOpen="prose"
    >
      {target
        ? fields.map((name) => (
            <ObjectFieldInput
              key={name}
              editor={editor}
              pos={target.pos}
              field={name}
              value={fieldValue(target, name)}
              claimsFocus={name === field}
            />
          ))
        : null}
    </EditorPopover>
  );
}

function ObjectFieldInput({
  editor,
  pos,
  field,
  value,
  claimsFocus,
}: {
  editor: Editor;
  pos: number;
  field: ObjectSurfaceField;
  value: string;
  claimsFocus: boolean;
}) {
  const controlId = useId();
  const takeFocus = useCallback(
    (control: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!control || !claimsFocus) return;
      control.focus();
      control.setSelectionRange(control.value.length, control.value.length);
    },
    [claimsFocus],
  );

  const shared = {
    id: controlId,
    className: "meridian-object-field-input",
    value,
    placeholder: fieldPlaceholder(field),
    onChange: (event: { currentTarget: { value: string } }) =>
      setObjectField(editor, pos, field, event.currentTarget.value),
  };

  return (
    <label className="meridian-object-field" htmlFor={controlId}>
      <span className="meridian-object-field-name">{objectFieldLabel(field)}</span>
      {field === "caption" ? (
        <textarea {...shared} ref={takeFocus} rows={2} />
      ) : (
        <input {...shared} ref={takeFocus} />
      )}
    </label>
  );
}

function fieldValue(target: ObjectSurfaceTarget, field: ObjectSurfaceField): string {
  const attribute = target.node.attrs[field];
  return typeof attribute === "string" ? attribute : "";
}

function fieldPlaceholder(field: ObjectSurfaceField): string {
  switch (field) {
    case "alt":
      return t`Describe the picture for a reader who cannot see it`;
    case "label":
      return t`fig:terrace`;
    case "caption":
      return t`What this figure shows`;
  }
}
