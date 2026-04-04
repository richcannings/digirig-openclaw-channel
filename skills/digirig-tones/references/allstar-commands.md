# AllStarLink Standard DTMF Commands

**Source:** https://allstarlink.github.io/basics/standardcommands/

AllStarLink is a network of amateur radio repeaters connected via VOIP.
These are the **mandatory** and **standard** DTMF codes that all AllStar nodes must support.

## Mandatory Commands (All Nodes)

| Code | Function |
|------|----------|
| *1 <node> | Disconnect from node |
| *2 <node> | Connect to node in monitor mode (listen only) |
| *3 <node> | Connect to node in transceive mode (talk + listen) |
| *4 <node> | Enter command mode on remote node |
| *70 | Local connection status |
| *99 | DTMF Phone Key (assert PTT from phone portal) |

**Notes:**
- `<node>` is an AllStar node number (e.g., 60216 for K6BJ)
- Node `0` = shorthand for last node operated on
- Monitor mode = listen but don't send audio
- Command mode = forward DTMF to remote node; press `#` to exit

## Common Optional Commands (Default on Most Nodes)

| Code | Function |
|------|----------|
| *80 | Force system ID |
| *81 | Say system time |
| *71 | Disconnect all links |
| *74 | Reconnect all links |
| *73 | System-wide connection status |
| *72 | Last active node |
| *75 | Link connect (local monitor only) |
| *76 | Disconnect from all nodes |
| *980 | Say app_rpt software version |

## Testing if a Repeater Has AllStar

To test if an unknown repeater supports AllStar, try these in order:

1. **`*70`** — Ask for link status. If the repeater responds with connection info, it has AllStar.
2. **`*81`** — Ask for system time. AllStar nodes will announce the time.
3. **`*980`** — Ask for software version. Only AllStar nodes respond to this.

If the repeater doesn't respond to any of these, it likely does not have AllStar.

## Looking Up Repeater Codes for Unknown Repeaters

When on a repeater you don't have codes for:

1. **Try standard AllStar commands** (*70, *81) to detect AllStar
2. **Search the web** for "[repeater callsign] DTMF codes" or "[repeater callsign] user guide"
3. **Check repeater directories:**
   - https://www.repeaterbook.com — search by callsign or location
   - https://allstarlink.org — search AllStar node database
4. **Ask the operator** — they may know the codes or the repeater's website
5. **Try *920** — some repeaters have interactive help menus

## Prefix Convention

Most AllStar/repeater controllers use this prefix pattern:
- `*1` — Disconnect
- `*2` — Monitor connect
- `*3` — Transceive connect
- `*6` — Autopatch / phone
- `*7` — Status / management
- `*9` — System info / help
