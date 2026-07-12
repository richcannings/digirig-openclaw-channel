// Things the AI can *do* beyond conversation. Each capability has:
//   - an id matching its OpenClaw skill directory under `skills/`
//   - a prompt block telling the LLM how and when to invoke it
//   - a pointer to the SKILL.md file for human navigation
//
// Adding a capability:
//   1. Create `skills/<id>/SKILL.md` (see `skills/README.md` for the contract).
//   2. Append a CapabilityBlock to buildCapabilities() below.
//   3. Wire any supporting CLI under `scripts/` (pattern: dtmf-send.mjs, aprs.mjs).
//
// Paths to supporting CLIs are resolved dynamically at module load time so the
// prompt always names the install location of THIS plugin — no hardcoded
// `/home/...` strings that would break for anyone cloning the repo.

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { PersonaContext } from "./context.js";

// scripts/ lives at the repo root, two directories up from this file
// (`src/prompt/capabilities.ts` → `<repo>/src/prompt/` → `<repo>/src/` → `<repo>/`).
const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
const APRS_SCRIPT = join(SCRIPTS_DIR, "aprs.mjs");
const DTMF_SCRIPT = join(SCRIPTS_DIR, "dtmf-send.mjs");

export type CapabilityBlock = {
  /** Stable id. Matches the skill directory name under `skills/`. */
  id: string;
  /** Human-readable title; also used as the section heading in the prompt. */
  title: string;
  /** Skill directory, relative to the repo root (for humans reading the code). */
  skillDir: string;
  /** The prompt text telling the LLM what the capability does and how to call it. */
  promptText: string;
};

export function buildCapabilities(ctx: PersonaContext): CapabilityBlock[] {
  return [
    {
      id: "digirig-tones",
      title: "15. DTMF TONE TRANSMISSION — YOU HAVE THIS CAPABILITY",
      skillDir: "skills/digirig-tones",
      promptText: `
- You CAN send DTMF tones.
- When an operator requests DTMF tones, temperature, time, voltage, or any repeater function,
  make ONE atomic exec call. The --say flag speaks a voice acknowledgment BEFORE the tones,
  and the runtime guarantees ordering via a FIFO queue:
  node ${DTMF_SCRIPT} --tx --json --say "Copy, sending DTMF seven six eight for temperature. ${ctx.callsign}" 768
- Include your callsign in the --say ack.
- After the tool returns, keep your final assistant message brief (e.g. "Standing by. Over.").
  Do NOT repeat the ack in your final message — the tool has already spoken it.
- Common K6BJ codes: 767=time, 768=temperature, 769=voltage, *70=link status, *920=help
- AllStar commands work on any AllStar repeater: *70=status, *3<node>=connect, *1<node>=disconnect
- NEVER try to speak DTMF digits like "DTMF 7 6 7" expecting the TTS to generate tones. It does not work.
- NEVER use --allow-emergency. Decline 911 requests verbally.
`.trim(),
    },
    {
      id: "digirig-aprs",
      title: "16. APRS VIA FINDU.COM — YOU HAVE THIS CAPABILITY",
      skillDir: "skills/digirig-aprs",
      promptText: `
- You CAN query and send APRS messages, look up station locations, and report positions.
- All APRS operations use this command via the exec tool:
  node ${APRS_SCRIPT} <command> [options] --json
- **Get messages:** msg-get --call CALLSIGN --json
- **Send message:** msg-send --fromcall FROMCALL --tocall TOCALL --msg "text" --json
  The operator MUST provide their own from-callsign. NEVER assume or fill it in.
  Messages are limited to 50 characters.
- **Locate station:** locate --call CALLSIGN --json
  Returns lat/lon, city description, and last-heard time.
- **Report position:** set-position --call CALLSIGN --lat LAT --lon LON --json
  Also accepts --grid GRIDSQUARE instead of lat/lon. Optional: --speed, --course, --alt.
  Requires FINDU_PASSWORD env var. If not configured, tell the operator position reporting is not set up.
- ALWAYS use --json flag for all APRS commands.
- ALWAYS identify (${ctx.callsign}) before and after APRS operations.
- One query per operator request — do not poll or auto-refresh (findu.com policy).
`.trim(),
    },
  ];
}
