# features/agents — Agent identity and selection

The prospective composer chooses an exact Agent definition. Existing
conversations display their bound Agent.

## Selection contract

General is a real system catalog entry backed by an immutable definition.
Creation sends both its catalog-entry ID and definition-revision ID.

`useAgentCatalog` acquires every visible catalog page under an account-and-Project
query key. Rows show name, effective model and a one-line hint. Hover and keyboard
focus reveal the full hint and unavailable reasons; unavailable choices remain
focusable but cannot be selected. Ownership and slugs are not picker labels.
Project pickers allow removal except for system General. Removal filters future
choices only, never existing bindings or other Projects. Unscoped catalog consumers
have no removal control; global Home redesign is outside this work.

Home Send reserves the selected Agent (default General) on the local thread
before persist. Catalog updates cannot replace that reserved choice. The
server remains the authority for admission of retained revisions.

## Controls and identity

| Surface | Behavior |
|---|---|
| Home/Chats creation composer | Interactive picker until creation is reserved. |
| Existing conversation, including zero turns | Readonly bound-Agent status. |
| Results provenance | Inert attribution inside the producing-thread link. |

Picker identity is name-led, without ownership badges. The toolbar owns trigger,
popover, focus repair, and close behavior; `AgentPickerPanel` owns catalog
rows and loading/error presentation.

## Owners

- `ComposerAgentControl.tsx`: prospective picker or readonly name.
- `AgentPicker.tsx`: exact selections and availability reasons.
- `constants.ts`: canonical General slug and display label.
- `creation-agent.ts`: exact selection plus display snapshot reserved at Send.
- Results attribution is projected from the producing conversation’s retained definition; it never queries a mutable slug catalog.
