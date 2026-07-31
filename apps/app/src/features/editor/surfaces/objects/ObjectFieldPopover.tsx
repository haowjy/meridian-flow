/**
 * The small popover the object's own words are edited in (§5.6: "Alt text edits
 * in a small popover").
 *
 * One surface for every field a registration declares, rather than one popover
 * per verb: the ⋮ item the writer picked decides which field takes the caret, and
 * a figure editing its caption can reach its label without going back to the
 * menu. Which fields are here at all is `surfaceFields` on the object's row, so
 * the inline picture and the captioned figure share this surface.
 *
 * **It writes as the writer types.** These are attributes on a node every peer
 * can see, and a form with a Save button would hold a second copy of the truth
 * for as long as it stayed open — the failure the figure's old node-view form
 * had. Each keystroke is one `setNodeMarkup`, so undo takes an edit back and a
 * collaborator watches the caption arrive.
 *
 * It holds the object the way every surface in this lane does: a `NodeHold`
 * resolved per render, so a peer's write cannot leave the popover writing into a
 * node that has moved or gone.
 */

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
  /** Resolved from the hold every render; null while a node view is rebuilding. */
  target: ObjectSurfaceTarget | null;
  /** The field the writer asked for, which is the one that takes the caret. */
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
      // The object's own bounds, re-measured on every reposition: the picture
      // scrolls with the manuscript and the popover travels with it.
      anchorRect={() => target?.element.getBoundingClientRect() ?? null}
      side="bottom"
      align="end"
      className="meridian-object-fields"
      // Focus is claimed below, on the field the writer actually asked for.
      // Radix's own entry focus takes the first control, which is the wrong one
      // whenever they picked the second or third verb.
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
  // A callback ref rather than an effect: it runs the moment the control exists,
  // which is before Radix would have moved focus anywhere else.
  const controlId = useId();
  const takeFocus = useCallback(
    (control: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!control || !claimsFocus) return;
      control.focus();
      // The caret at the end of what is already written: the writer came here to
      // add to it more often than to replace it.
      control.setSelectionRange(control.value.length, control.value.length);
    },
    [claimsFocus],
  );

  const shared = {
    id: controlId,
    className: "meridian-object-field-input",
    value,
    placeholder: fieldPlaceholder(field),
    // Straight through to the document: see the header on why there is no draft.
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
