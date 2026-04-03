# K6BJ 2-Meter Repeater User Control Codes

**Rev 6 N6QX 12 Mar 2021**

## Usage Protocol
- **Listen for at least 30 seconds** to ensure the repeater is not in use
- **Identify** before and after using control functions
- Report repeater problems to John, N6QX, at den6qx@gmail.com

## Phone Patch
| Code | Function |
|------|----------|
| `831 nnn nnnn` | Phone Patch dial command (7-digit telephone number) |
| `73` | Hang up the phone. **Please identify.** |
| `78911` | **EMERGENCY** - Calls the 911 Emergency Center |
| `**` | Patch Extend - Resets phone patch time-out timer |

**Patch Extend Notes:**
- May be sent at any time during a call
- Should be sent immediately if you hear a warning beep during long calls

## IRLP and Echolink
**K6BJ is connected to IRLP Node 3318**

| Code | Function |
|------|----------|
| `33 nnnn` | IRLP Connection Request (nnnn = IRLP node number) |
| `73` | Ends the IRLP connection. **Please identify.** |
| `*nnnnnn` | Echolink Connection Request (nnnnnn = Echolink node) |
| `73` | Ends the Echolink connection. **Please identify.** |

## Function Control Codes
| Code | Function |
|------|----------|
| `767` | **Time Request** - Repeater announces current time |
| `768` | **Temperature Request** - Outside and equipment rack temperatures |
| `769` | **Voltage Request** - Current AC and battery voltages |
| `729 nnnnn` | **DTMF Dial Pad Test** - Repeater reads back 1-16 digits you send |
| `28*` | **Signal Replay Test** - Record and playback your signal quality |

### Signal Replay Procedure (`28*`)
1. Send DTMF `28*` and release PTT
2. Repeater responds with "Ready."
3. Press PTT and talk for **up to 10 seconds**
4. Release PTT
5. Repeater plays back your received signal

### DTMF Test Notes (`729`)
- Send 1-16 digits after the `729` code
- Repeater will read back the digits you pressed
- Note: The letter 'D' on the touchtone pad cannot be read back

## AI Voice Command Examples

**For use with DigiRig AI assistant:**

```
"Send DTMF 767"               → Time request
"Transmit DTMF 768"          → Temperature report
"DTMF 769"                   → Voltage report
"Send DTMF 831 555 1234"     → Phone patch to 555-1234
"Transmit 78911"             → Emergency 911 call
"DTMF 33 1234"               → Connect to IRLP node 1234
"Send DTMF star 98765"       → Echolink to node *98765
"Transmit 73"                → Hang up / disconnect
"DTMF 28 star"               → Signal replay test
"Send DTMF 729 12345"        → DTMF test with digits 12345
"Transmit double-star"       → Patch extend (***)
```

## Emergency Procedures

**For 911 Emergency:**
1. Send DTMF `78911`
2. Wait for connection to 911 center
3. Provide clear, concise emergency information
4. Give location and nature of emergency
5. Follow 911 operator instructions
6. Hang up with DTMF `73` when instructed
7. **Identify immediately after hanging up**

## Integration with DigiRig AI

The AI assistant can now:
- Recognize voice commands for K6BJ control codes
- Generate appropriate DTMF sequences
- Provide confirmation of function requests
- Guide users through proper repeater etiquette
- Assist with emergency procedures

**Example Interaction:**
```
Operator: "I need the time"
AI: "Transmitting time request. DTMF 7 6 7. W6RGC slash AI."
Repeater: [Announces current time]
AI: [Stays silent to avoid interference with announcement]
```