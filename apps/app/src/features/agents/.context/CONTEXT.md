# features/agents — Agent identity and selection

The prospective composer chooses an exact Agent definition. Existing
conversations display their bound Agent.

## Selection contract

General is a real system catalog entry backed by an immutable definition.
Creation sends both its catalog-entry ID and definition-revision ID.

`useAgentCatalog` acquires every account/system catalog page under an
account-keyed query. The picker works before a project exists, groups Personal
and System entries, and displays unavailable entries with disabled choices and
their reasons. Entry and revision IDs distinguish choices that share a slug.

The account creation owner persists the selection and its name/slug display
snapshot before requests. Catalog updates cannot replace a reserved choice.
A definite refusal permits correction; an ambiguous attempt retains its IDs and
selection for reconciliation. The server remains the authority for admission
of retained revisions.

## Controls and identity

| Surface | Behavior |
|---|---|
| Home/Chats creation composer | Interactive picker until creation is reserved. |
| Existing conversation, including zero turns | Readonly bound-Agent status. |
| Results provenance | Inert attribution inside the producing-thread link. |

Agent identity uses a name and source badge. The toolbar owns trigger,
popover, focus repair, and close behavior; `AgentPickerPanel` owns catalog
rows and loading/error presentation.

## Owners

- `ComposerAgentControl.tsx`: prospective picker or readonly name.
- `AgentPicker.tsx`: exact selections and availability reasons.
- `constants.ts`: canonical General slug and display label.
- `client/first-send-continuity`: durable creation choices, attempts, and
  destination admission.
- Results attribution is projected from the producing conversation’s retained definition; it never queries a mutable slug catalog.
