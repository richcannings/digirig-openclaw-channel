# DigiRig Skills

OpenClaw skills the LLM can invoke while operating this radio channel. Each
skill is a directory the LLM can load for detailed instructions or references
when it decides to use the corresponding capability.

## Current skills

| Skill | Capability | Prompt block | Supporting CLI |
|-------|------------|--------------|----------------|
| [`digirig-tones/`](./digirig-tones/SKILL.md) | DTMF tone transmission over the air | `CAPABILITIES[0]` in [`src/prompt/capabilities.ts`](../src/prompt/capabilities.ts) | [`scripts/dtmf-send.mjs`](../scripts/dtmf-send.mjs) |
| [`digirig-aprs/`](./digirig-aprs/SKILL.md) | APRS message, location, and position-report queries via findu.com | `CAPABILITIES[1]` in [`src/prompt/capabilities.ts`](../src/prompt/capabilities.ts) | [`scripts/aprs.mjs`](../scripts/aprs.mjs) |

## Contract (the `SKILL.md` shape)

Each skill directory contains a `SKILL.md` with frontmatter:

```markdown
---
name: <stable-id>
description: >
  <one paragraph description. The LLM reads this to decide whether to load
  the skill. Be concrete about triggers ("use when operators ask for X").>
---

# <Human Title>

## Capabilities / Exact Steps / Command Reference / …
```

Supporting material — repeater code tables, endpoint references, worked
examples — goes under `<skill>/references/`. The LLM loads those on demand
when a `SKILL.md` tells it to.

## Adding a new skill

1. **Create the skill directory** with a `SKILL.md` following the shape above.
   If the skill needs reference data (codes, endpoints, example inputs), put
   them under `<skill>/references/`.
2. **Add a supporting CLI under `scripts/`** if the skill dispatches to an
   external tool. The established pattern:
   - Accept a `--json` flag; print structured output so the LLM can reason
     about the result.
   - Exit non-zero on error with a readable message.
   - See `scripts/dtmf-send.mjs` and `scripts/aprs.mjs` for reference.
3. **Register the capability** by appending a `CapabilityBlock` to
   `CAPABILITIES` in [`src/prompt/capabilities.ts`](../src/prompt/capabilities.ts).
   The `promptText` tells the LLM *when* to reach for the skill and *how* to
   invoke the supporting CLI.
4. **Update this table** with a row linking the new skill.

## Why this layout

- `SKILL.md` is for the LLM (loaded at agent runtime when it decides to use
  the capability).
- `src/prompt/capabilities.ts` is for the always-on system prompt — the LLM
  reads this *before* deciding to reach for a skill.
- `scripts/*.mjs` is the actual invocation target; it should be runnable by a
  human at the shell too, for smoke-testing and debugging.

Keeping these three in lockstep is the point of the `CapabilityBlock.skillDir`
field: the code reference points back at the human-authored skill doc, so
wandering from one to the other is one jump.
