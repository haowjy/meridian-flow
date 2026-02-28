# Critical Gap: Multi-Harness Support for Lifecycle Hooks

**Status:** RESEARCH IN PROGRESS
**Date:** 2026-02-28
**Urgency:** HIGH — Design must account for all supported harnesses

---

## The Gap

Our current lifecycle hooks design assumes:
- System prompt can be modified per run ✅ (Works for Claude)
- Hooks available (SessionStart, SessionEnd, etc.) ✅ (Orchestrate has them)
- Skills can be pinned and injected ✅ (Works for Claude)

**But meridian-channel supports multiple harnesses with different capabilities:**

```
Claude:      Skills ✅  | Hooks ? | System Prompt ✅  | Files ✅
Codex:       Skills ❌  | Hooks ? | System Prompt ?   | Files ?
OpenCode:    Skills ❌  | Hooks ? | System Prompt ?   | Files ?
Cursor:      Unknown    | Unknown | Unknown          | Unknown
```

**Critical observation:** Both Codex and OpenCode harness adapters **DROP skills**.

---

## What We Know (From Code Inspection)

### Meridian-Channel's Harness Adapters

**Claude** (`src/meridian/lib/harness/claude.py`):
- Skills: FULL SUPPORT (passed through to harness)
- Session resume: NOT YET
- Artifact extraction: Yes (usage, session ID, tasks)

**Codex** (`src/meridian/lib/harness/codex.py`):
```python
STRATEGIES = {
    "model": FlagStrategy(...),
    "agent": FlagStrategy(effect=FlagEffect.DROP),
    "skills": FlagStrategy(effect=FlagEffect.DROP),  # ← DROPPED!
    ...
}
```
- Skills: NOT PASSED to `codex` CLI
- Session resume: YES (via `codex exec resume <session_id>`)
- But: unclear if skills work any other way

**OpenCode** (`src/meridian/lib/harness/opencode.py`):
```python
STRATEGIES = {
    "model": FlagStrategy(...),
    "agent": FlagStrategy(effect=FlagEffect.DROP),
    "skills": FlagStrategy(effect=FlagEffect.DROP),  # ← DROPPED!
    ...
}
```
- Skills: NOT PASSED to `opencode` CLI
- Session resume: YES
- Session fork: YES (advanced feature)
- But: unclear if skills work any other way

**Cursor**:
- No adapter in meridian-channel yet
- Status unknown

---

## Questions Requiring Research

1. **Why are skills dropped for Codex/OpenCode?**
   - Is it a technical limitation (CLI doesn't support `--skills`)?
   - Or just not implemented yet?
   - Could skills be injected into the prompt text instead?

2. **How do Codex/OpenCode handle system prompts/instructions?**
   - Claude: `--system` flag or system prompt in request
   - Codex: ? (OpenAI doesn't support explicit system prompt flag?)
   - OpenCode: ? (similar to Codex?)

3. **Hooks support?**
   - Do Codex/OpenCode respect `.claude/hooks/` or equivalent?
   - Can hooks detect compaction / context loss?
   - OpenCode has `opencode/plugins/orchestrate.ts` — does that mean hooks work?

4. **Fallback strategies for harnesses without hooks?**
   - If no hooks available, can we fall back to "always inject into prompt text"?
   - Or should pinning be Claude-only initially?

---

## Design Implications

### Scenario A: Hooks Work for All Harnesses
**If** SessionStart/SessionEnd hooks work for Claude, Codex, OpenCode:
- Current design applies to all harnesses
- Skills injected at run start (via hook + prompt)
- Files injected at run start (via hook + prompt)
- ✅ Seamless across harnesses

### Scenario B: Hooks Only Work for Claude
**If** Codex/OpenCode don't support hooks:
- **Files:** Can still be injected via `-f <file>` on each run
- **Skills:** Can be injected into prompt text (not dropped like CLI flag)
- **Pinning:** Still works, but restoration is manual or CLI-based
- **Fallback:** `meridian context refresh` — manual re-injection

### Scenario C: Codex/OpenCode Don't Support Skills At All
**If** skills can't be restored on Codex/OpenCode:
- File pinning still works (inject as context)
- Skill pinning only works on Claude
- Need harness-specific documentation
- Warning: "Skills are Claude-only for now"

---

## What Research Task Will Clarify

Running: `run-agent.sh --model gpt-5.3-codex --skills researching`

**Will investigate:**
1. OpenAI Codex CLI capabilities (system prompt, hooks, skills)
2. Google OpenCode capabilities (same questions)
3. Cursor capabilities (if available)
4. Fallback patterns used by similar tools
5. Recommendations for meridian design

**Expected output:** Harness compatibility matrix + design recommendations

---

## Design Decisions Pending Research

### For Phase 1 Implementation

Choose one of:

**Option A: Claude-first approach**
- Implement full lifecycle hooks for Claude
- Accept that Codex/OpenCode have limited support (manual refresh)
- File pinning works everywhere, skill pinning is Claude-only
- ✅ Simpler implementation
- ❌ Inconsistent UX across harnesses

**Option B: Harness-agnostic approach**
- Design pinning + injection to work for ALL harnesses
- Use prompt text injection instead of CLI flags (works everywhere)
- Hooks optional (nice-to-have, not required)
- ✅ Consistent UX
- ❌ More complex implementation

**Option C: Hybrid approach**
- Full hooks for Claude
- Text-injection fallback for Codex/OpenCode
- Same UX everywhere, different internals per harness
- ✅ Best of both worlds
- ❌ Requires more upfront design

---

## Recommendation (Preliminary)

Until research completes, **assume Option C (Hybrid):**

1. **Claude:** System prompt + hooks + file injection (as designed)
2. **Codex/OpenCode:** Always inject into prompt text (no hooks needed)
   - Skills added to prompt: "You have access to: researching, reviewing"
   - Files added to prompt: "Pinned files: src/main.py, docs/api.md"
   - Same `pinned.json` storage, different injection path
3. **Restoration:** Auto at run start (via prompt injection) for all harnesses

This way:
- ✅ Same CLI UX across all harnesses
- ✅ Same data model (`pinned.json`)
- ✅ Different internals per harness (Claude hooks, others via text)
- ✅ No breaking changes if Codex/OpenCode add hook support later

---

## Next: Wait for Research Results

The codex research task (`b5t9a2uwv`) is investigating real implementations and documentation.

Once complete, we'll have:
- [ ] Actual OpenAI Codex CLI capabilities
- [ ] OpenCode capabilities (if available)
- [ ] Cursor capabilities (if supported)
- [ ] Recommended fallback patterns from industry
- [ ] Final design recommendation per harness

**ETA:** ~5 minutes
