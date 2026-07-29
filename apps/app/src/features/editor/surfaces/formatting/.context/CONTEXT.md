# surfaces/formatting — contracts

Reference depth for the formatting menu. Read [`AGENTS.md`](../AGENTS.md)
first.

## What the menu shows

| Row | Contents | Where the state comes from |
|---|---|---|
| marks | Bold, Italic, Strikethrough, Inline code | `textMarkState(editor, mark)` |
| Turn into ▸ | Paragraph, Heading 1 to 3, Bulleted list, Numbered list, Quote, Code block | `blockTypeStates(editor)` |
| link | Add link, opening the toolbar's own popover flow | `textMarkState(editor, "link")` |
| clipboard | Cut, Copy, Paste, each with its shortcut | this module |

Marks light when applied and reverse on the next press (law 6). Turn into
checks the type the blocks already are and converts back to a paragraph when
that type is chosen again; the check is a radio-style state display, so
choosing the already-checked Paragraph is a no-op rather than a dead control.

The submenu greys **as a whole** when every type refuses for one reason, which
is the ordinary case (a table cell, a diagram, a mixed selection). Opening onto
eight dead rows would satisfy the letter of law 5 and none of its point.

## The two questions, and where each door asks them

Both doors run `isProseSelection` and `formattingOwnsContext`, which is what
keeps the split matrix true for the keyboard as well as the mouse.

`isProseSelection` is the kernel's own `proseSelectionCovers`, not a second
opinion: non-empty, and a `TextSelection` or `AllSelection` rather than a
`NodeSelection` on a figure or a `CellSelection` over a table.

`formattingOwnsContext` allows `document`, `table`, and `table-cell`. Two
contexts are missing on purpose. An **object** has no text to format. A
**source block** owns its own chrome (§5.3, law 4): a menu offering Heading
over a fence is the F6 accident, and a menu offering nothing over one spends
the browser's menu for no gain.

**The claim** additionally requires an editable document, `insideTextSelection`
(the pointer is in the selection, not merely near one), and a pointer that is
not on portalled chrome (`editorChromeAttributes`, qualified by this editor's
id). It reads the context under the POINTER, which is the finer answer: the
writer aimed at a place inside their selection, and that place may be a
diagram.

**The keyboard door** reads the context under the SELECTION and declares it
twice: `formattingMenuOpensFor` checks it, and the keymap contribution carries
`appliesTo: formattingOwnsContext` so the kernel never even offers the key in a
context this menu does not own.

## Touch has no door of its own

A long press is a `contextmenu` on every browser that gives the page one, so it
arrives through the claim ladder like any other right-click. That is the whole
touch path, and it is the only version of it that can lose: a private pointer
timer cannot ask whether the link or the diagram under the finger outranks this
rung, and it opens beside a native callout it has no way to suppress.

**iOS Safari gives no such event for a long press on text.** The formatting
menu is therefore absent there, and the OS callout (Copy, Look Up, Share)
stands. Absent beats two menus over one gesture (law 5 prefers absent to dead,
and ruling 11 protects the native surface). Reopening this needs a real iOS
Safari probe and a platform-valid way to suppress the callout once the gesture
is claimed; nothing here should grow a timer again without both.

## Handing off to another surface

The link form opens synchronously from the menu item, and that is the whole
handoff. `useChromeLayer`'s `onCloseAutoFocus` returns the caret to the prose
only when the closing surface was the last one on screen, so a form that
registered its layer first is left alone.

Anything that waits — a frame, a timeout, the editor's focus event — reopens
against a writer who has already moved on: the anchor is stale and the draft
resolves against a selection they made afterwards. Open, or do not.

## Escape inside the submenu

Radix answers Escape in a submenu by closing the whole menu, and the kernel's
`useChromeLayer` guard cannot see it: Radix's sub content dismisses through the
root's context rather than through the root content's `onEscapeKeyDown`. The
submenu is controlled here and takes the key itself, so one Escape closes the
list, the next closes the menu, and the third is at-home.

## The clipboard

A keystroke arrives as a clipboard event and ProseMirror handles it. A menu
item arrives with focus in a portal and no event, so `clipboard-commands.ts`
reaches the clipboard through `navigator.clipboard` and the document through
`view.serializeForClipboard`. Copy writes `text/html` (carrying ProseMirror's
slice depths, so a paste back keeps its blocks) and `text/plain`.

Both directions can be withheld, and each reports which: a capability check
answers before the writer presses, and a `denied` or `unavailable` result greys
that direction from then on with its shortcut in the reason. The check alone
cannot cover it — a browser that exposes `clipboard.read` and then refuses the
call looks available until it is asked.

A cut copies before it deletes and stops if the copy was refused, or it would
take the writer's words with nothing to paste back. A payload reaches the
document verbatim: emptiness is tested on a trimmed copy, never on the payload,
because a pasted code line's indentation is content.

## Verified in the browser

Chromium, portless dev stack, re-run after the kernel merge. Right-click over a
selection opens at the pointer; at a bare caret `defaultPrevented` stays false
and the browser keeps its menu; inside a code fence the same, and Shift+F10
there declines with it. A `contextmenu` inside the selection — the shape a
touch long press arrives in — is claimed and opens at the point, while a bare
`pointerdown` held for two seconds opens nothing. Italic lights over an italic
run and reverses. Turn into checks the current type, converts, and reverses; a
selection across two sibling lists un-lists both in one choice and keeps the
writer's words selected. Table cells grey Turn into with "Table cells hold
plain paragraphs." Add link opens the form in one mutation and it stays, with
Escape returning the caret and the selection. Cut and Copy reach the system
clipboard; a withheld read greys Paste with "Press Ctrl+V".
