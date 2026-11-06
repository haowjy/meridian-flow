# surfaces/formatting — contracts

The Turn into submenu greys as a whole when every type refuses for one reason, the ordinary
case; opening onto eight dead rows would offer eight things that can't happen.

## Right-click rungs

Two rungs, one menu: `text-selection` for a sweep the pointer is inside, and `caret`, the
ladder's floor, for every other right-click in prose. The caret rung moves the caret to the
pointer synchronously before opening, so Turn into converts the block the writer aimed at.
The keyboard twin (Menu key, Shift+F10) has no caret rung.

## The two questions

Both doors run `isProseSelection` and `formattingOwnsContext`, which keeps the split true for
the keyboard as well as the mouse. `formattingOwnsContext` leaves out `object`, which has no
text to format, and source blocks, where a menu offering Heading over a fence would rewrite
the fence by accident.

The claim reads the context under the pointer: the writer aimed at a place inside their
selection, and that place may be a diagram. The keyboard door reads it under the selection,
and the keymap carries `appliesTo: formattingOwnsContext` so the kernel never offers the key
in a context this menu doesn't own.

## Touch

A long press is a `contextmenu` where a browser gives the page one, so it arrives through the
claim ladder. A private pointer timer can't ask whether the link or diagram under the finger
outranks this rung, and it opens beside a native callout it can't suppress.

iOS Safari gives no such event for a long press on text, so the menu is absent there and the
OS callout stands. Reopening this needs a real iOS Safari probe and a platform-valid way to
suppress the callout once the gesture is claimed.

## Handing off

The link form opens synchronously from the menu item. Anything that waits (a frame, a timeout,
the editor's focus event) reopens against a writer who has moved on: the anchor is stale and
the draft resolves against a later selection.

## Escape inside the submenu

Radix answers Escape in a submenu by closing the whole menu, and `useChromeLayer` can't see it:
sub content dismisses through the root's context, not the root content's `onEscapeKeyDown`. The
submenu is controlled here and takes the key itself.

## The clipboard

A menu item arrives with focus in a portal and no clipboard event, so `clipboard-commands.ts`
goes through `features/editor/clipboard.ts` and `view.serializeForClipboard`. Copy writes
`text/html`, carrying ProseMirror's slice depths so a paste back keeps its blocks, and
`text/plain`.

A capability check answers before the writer presses, but a browser that exposes
`clipboard.read` and then refuses the call looks available until asked, so a `denied` or
`unavailable` result also greys that direction for as long as the menu is open.

A clipboard row takes the select rather than letting Radix close on it: the verb is
asynchronous, and a refusal drawn after the close would land on a row that had gone. `closeMenu`
is how the mounting menu says how it closes.

A cut copies before it deletes and stops if the copy was refused. A payload reaches the document
verbatim: emptiness is tested on a trimmed copy, because a pasted code line's indentation is
content.
