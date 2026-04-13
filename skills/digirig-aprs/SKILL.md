---
name: digirig-aprs
description: >
  Query and interact with APRS via findu.com. Use when operators ask about
  APRS messages, station locations, or want to send APRS messages or position
  reports. Triggers on requests like "check APRS messages for N6YRC", "where
  is W6RGC on APRS", "send an APRS message to KJ6DZB", or "report my position".
---

# DigiRig APRS (via findu.com)

## Capabilities

1. **Get APRS messages** for any callsign
2. **Send APRS messages** to any callsign (operator must provide their own from-callsign)
3. **Locate a station** — get lat/lon and description from APRS position reports
4. **Report position** — send a position report for a callsign (requires FINDU_PASSWORD)

## Command Reference

All commands use:
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs <command> [options] --json
```

### Get Messages
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs msg-get --call CALLSIGN --json
```
Returns recent APRS messages to/from the callsign.

### Send a Message
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs msg-send --fromcall FROMCALL --tocall TOCALL --msg "message text" --json
```
- **The operator MUST provide their from-callsign.** Do not assume or fill in a from-callsign.
- Message text is limited to 50 characters.
- The message is injected into the APRS-IS network and delivered over RF.

### Locate a Station
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs locate --call CALLSIGN --json
```
Returns latitude, longitude, description (distance/bearing from nearest city), and when the last position report was received.

### Report Position
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs set-position --call CALLSIGN --lat 37.0 --lon -122.0 --json
```
Or using Maidenhead grid square:
```
node /home/richc/src/digirig-openclaw-channel/scripts/aprs.mjs set-position --call CALLSIGN --grid CM87wj --json
```
Optional: `--speed`, `--course`, `--alt`

**Requires `FINDU_PASSWORD` environment variable.** Only works for the registered callsign. If the password is not configured, inform the operator that position reporting is not set up.

## Exact Steps for Each Request

### When an operator asks to check APRS messages:
1. Speak: *"Checking APRS messages for [callsign]. W6RGC/AI"*
2. Run: `node .../aprs.mjs msg-get --call CALLSIGN --json`
3. Read the JSON result and relay the messages (or "no messages found") to the operator.

### When an operator asks to send an APRS message:
1. **Ask the operator for their callsign** if they haven't provided it. You must have a from-callsign.
2. Confirm: *"Sending APRS message from [from] to [to]: [message]. W6RGC/AI"*
3. Run: `node .../aprs.mjs msg-send --fromcall FROM --tocall TO --msg "message" --json`
4. Confirm success or report error.

### When an operator asks where a station is:
1. Speak: *"Looking up [callsign] on APRS. W6RGC/AI"*
2. Run: `node .../aprs.mjs locate --call CALLSIGN --json`
3. Relay the location description, coordinates, and last-heard time.

### When an operator asks to report a position:
1. Gather callsign and position (lat/lon or grid square) from the operator.
2. Speak: *"Sending position report for [callsign]. W6RGC/AI"*
3. Run: `node .../aprs.mjs set-position --call CALLSIGN --lat LAT --lon LON --json`
4. Confirm success or report error.

## Critical Rules

- **ALWAYS use `--json` flag** for machine-readable output.
- **NEVER fabricate a from-callsign.** The operator must provide it for msg-send.
- **Messages are limited to 50 characters.** If the operator's message is too long, ask them to shorten it.
- **Position reporting requires FINDU_PASSWORD.** If not configured, say so — don't guess credentials.
- **One request at a time.** findu.com prohibits automated/repetitive scraping. Each command should correspond to an operator request.
- Always identify (W6RGC/AI) before and after APRS operations.
