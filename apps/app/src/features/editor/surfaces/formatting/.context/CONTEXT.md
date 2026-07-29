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

## The claim, rung by rung

Registered at the ladder's `text-selection` rung, under `link` and over
`grip`/`object`. `claimsFormattingMenu` takes a right-click only when all of
these hold:

1. the document is editable — a read-only document has no verb worth the
   browser's menu, and Copy is already in that menu;
2. the selection is a non-empty `TextSelection` or `AllSelection` — a
   `NodeSelection` is an object and a `CellSelection` is a table, both other
   lanes';
3. the pointer is inside that selection (`insideTextSelection`), not merely
   somewhere while a selection exists elsewhere;
4. the pointer is not on portalled chrome (`data-editor-chrome`), whose lane
   claims further down the ladder;
5. the pointer's context is `document`, `table`, or `table-cell`.

Rung 5 is where the two absences live. An **object** has no text to format. A
**source block** owns its own chrome (§5.3, law 4): a menu offering Heading
over a fence is the F6 accident, and a menu offering nothing over one spends
the browser's menu for no gain.

## The other two doors

`ContextMenu` and `Shift-F10` register at keymap scope `document`, from a React
effect — never TipTap's `onCreate`, which fires a macrotask late. They open at
`view.coordsAtPos(selection.to)`, where the writer's attention already is.

Long press is a pointer timer on the editor's DOM: 500 ms, cancelled by 10 px
of travel, by pointerup, by a scroll, and by the kernel's suppression. Android
answers a long press with its own `contextmenu`, so the timer and the claim
both fire for one gesture; whichever lands first owns it and the other stands
down for 700 ms. The claim still returns true in that window — the native menu
must not arrive over the menu the writer is looking at — but it does not
re-open, which would remount at a point one pixel away.

## Handing off to another surface

The link form opens only once the editor has focus again.

Every editor surface returns the caret to the prose on close (the chrome
contract), and TipTap's `focus` command lands a frame late. A form mounted
straight away sees that arrival as focus leaving and dismisses itself inside
40 ms — observed in the browser, invisible to any unit test. So `openLinkForm`
waits on the editor's own `focus` event, with a 300 ms fallback so a focus that
never arrives cannot swallow the writer's click.

**Any lane opening a popover or dialog from a menu item owes the same wait.**

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

Reading is the asymmetric half: writing works everywhere, reading is withheld
by whole browsers and by permission. `pasteIntoSelection` reports which, and a
`denied` or `unavailable` answer greys Paste from then on with the shortcut in
its reason. The capability check alone cannot cover it — a browser that exposes
`clipboard.read` and then refuses the call looks available until it is asked.

## Verified in the browser

Chromium, portless dev stack. Right-click over a selection opens at the
pointer; at a bare caret `defaultPrevented` stays false and the browser keeps
its menu; inside a code fence the same. Italic lights over an italic run and
reverses. Turn into checks the current type, converts, and reverses. Table
cells grey Turn into with "Table cells hold plain paragraphs."; inline code
greys Bold with "Inline code takes no other formatting." and keeps Inline code
itself removable. Shift+F10 and the Menu key open at the selection; Escape
walks one step per press and lands focus in the prose with the selection
intact. Cut and Copy reach the system clipboard; a withheld read greys Paste
with "Press Ctrl+V". A synthesized touch press opens at the touch point and
cancels on travel or away from the selection.
