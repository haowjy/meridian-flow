# surfaces/toolbar

The persistent document toolbar. Contextual surfaces own their menus, forms, table verbs
and object controls; none of those migrate into this row.

- `toolbar-commands.ts` is the single enablement and refusal predicate. A control never
  advertises a dispatch that will refuse, and what is on can always come off.
- Components don't classify table cells or object types; the commands do.
- Any surface opened here returns the caret to the editor on every close path.

Reason logic, greying and caret return: [`.context/CONTEXT.md`](.context/CONTEXT.md).
