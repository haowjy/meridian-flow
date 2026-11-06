# extensions/auto-pair — closers the editor writes

`auto-pairs.ts` is the registry and `AutoPairExtension.ts` the mechanism; both
headers explain the rules.

- A pair opener is one character. A multi-character row needs a different
  mechanism.
- No Esc, Tab or Enter binding belongs here. Backspace is consumed only when a
  tracked pair is present, and composition input is left alone.
