# findu.com APRS Endpoints

| Action | Endpoint | Key Parameters |
|--------|----------|---------------|
| Get messages | `msg.cgi?call=CALL` | `call` (required) |
| Send message | `sendmsg.cgi?fromcall=X&tocall=Y&msg=Z` | `fromcall`, `tocall`, `msg` (max 50 chars) |
| Locate station | `find.cgi?call=CALL` | `call` (supports wildcards) |
| Position CSV | `posit.cgi?call=CALL&comma=1` | `call`, `comma=1` for CSV |
| Report position | `inputpos.cgi?call=CALL&passwd=PW&lat=X&lon=Y` | `call`, `passwd`, `lat`/`lon` or `grid` |

## Additional Endpoints (not scripted, but available)

| Endpoint | Purpose |
|----------|---------|
| `raw.cgi?call=X&time=1` | All raw APRS packets with timestamps |
| `rawposit.cgi?call=X&time=1` | Raw position packets only |
| `near.cgi?call=X` | Find nearby APRS stations |
| `wxpage.cgi?call=X` | Weather station data |

## Usage Policy

findu.com prohibits repetitive automated scraping. A single access per user-initiated request is allowed. Do not poll or refresh automatically.
