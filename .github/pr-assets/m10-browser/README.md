# M10 whole-feature browser run

Probed on `feat/document-commands` at `1dad75c112` (spawn p16996). Mock provider for scripted rounds; live `deepseek-flash` for 07.

| File | What it shows |
| --- | --- |
| [00-chat-open.png](00-chat-open.png) | Chat open, Auto-apply, Work bound |
| [01-draft-typing-while-round.png](01-draft-typing-while-round.png) | Draft mode: typed in Live while the round ran |
| [01-draft-writer-and-model-text.png](01-draft-writer-and-model-text.png) | Draft view: three AI edits (green) plus the writer's paragraph |
| [01-draft-applied.png](01-draft-applied.png) | After Apply: both texts in Live, once |
| [02-autoapply-typing.png](02-autoapply-typing.png) | Auto-apply: writer sentence in before model edits |
| [02-autoapply-before-edits.png](02-autoapply-before-edits.png) | Same, still waiting |
| [02-autoapply-all-edits-and-typing.png](02-autoapply-all-edits-and-typing.png) | Three live edits plus the crow sentence |
| [02-autoapply-landed.png](02-autoapply-landed.png) | Settled: Edited 1 document |
| [03-stop-mid-round.png](03-stop-mid-round.png) | First edit live, Stop visible, second edit not run |
| [03-stop-settled.png](03-stop-settled.png) | After Stop: first edit stays; card does not say cancelled |
| [03-stop-turn-undo.png](03-stop-turn-undo.png) | Chat-card Undo took the landed edit back |
| [04-crash-before-kill.png](04-crash-before-kill.png) | First crash-round edit live, Stop visible |
| [04-crash-offline.png](04-crash-offline.png) | After `kill -9` of nitro: Reconnecting, edit kept |
| [04-crash-recovered.png](04-crash-recovered.png) | Reload: This response failed, Retry, edit once |
| [04-next-message-after-crash.png](04-next-message-after-crash.png) | Next message ran |
| [06-dock-discard-during-round.png](06-dock-discard-during-round.png) | Dock Discard/Apply disabled while a round is still running |
| [06-refused-write-after-discard.png](06-refused-write-after-discard.png) | After a mid-round Discard: later write refused, then a read |
| [06-write-after-reread.png](06-write-after-reread.png) | Couldn't edit, then the write after re-read in the draft |
| [07-live-deepseek-flash.png](07-live-deepseek-flash.png) | Live `deepseek-flash` reply |
