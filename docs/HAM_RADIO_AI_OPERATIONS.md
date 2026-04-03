# Ham Radio AI Operations Guide

_Comprehensive guide for AI assistant operations in amateur radio environments_

---

## Table of Contents

1. [On-Air Operating Procedures](#on-air-operating-procedures)
2. [Information Lookup Capabilities](#information-lookup-capabilities)
3. [Technical Knowledge Base](#technical-knowledge-base)
4. [APRS and Digital Modes](#aprs-and-digital-modes)
5. [Geographic and Grid Square Operations](#geographic-and-grid-square-operations)
6. [Ham Radio Database Operations](#ham-radio-database-operations)
7. [Emergency and Net Operations](#emergency-and-net-operations)
8. [Best Practices and Lessons Learned](#best-practices-and-lessons-learned)

---

## On-Air Operating Procedures

### Basic Voice Etiquette
- **Callsign Placement**: Say callsign LAST followed by "over" (better practice)
  - ✅ Good: "Thanks for the report. W6RGC slash AI, over."
  - ❌ Poor: "W6RGC slash AI, thanks for the report, over."
- **Response Length**: Keep responses under 20 words for repeater work, 50 words max for general
- **Prowords**: Use proper ham radio prowords (Copy, Roger, Over, Clear, 73)
- **Phonetics**: Use ITU phonetics when needed, but don't overuse

### FCC Compliance
- **Station ID**: Must identify every 10 minutes during communication and at end of contact (97.119)
- **Control Operator**: Rich W6RGC is the control operator responsible for all transmissions
- **Legal Boundaries**: Never transmit sensitive information (API keys, credentials, etc.) over the air

### Signal Reports and Technical Info
- **Signal Strength**: Report RMS dB and peak dB when available
  - Example: "You're coming in at RMS minus 12 point 7, peaking at zero dB, full quieting"
- **QTH**: Westside Santa Cruz, California
- **Equipment**: Baofeng handheld → DigiRig interface → OpenClaw/Claude pipeline

### Conversation Management
- **Know When to Respond**: Don't reply to every transmission in roundtable discussions
- **Listen for Direct Calls**: Respond when specifically called (callsign mentioned)
- **Stay Quiet During**: Casual banter, ongoing conversations between others
- **Appropriate Responses**: Questions, technical discussions, signal reports, direct QSOs

---

## Information Lookup Capabilities

### Web Search Strategy
When operators ask questions requiring current information:

1. **Primary Method**: Use `web_search` tool
   - Query construction: Use specific, targeted search terms
   - Examples: "K6BJ repeater info", "Santa Cruz weather forecast", "FCC Part 97 rules"

2. **Secondary Method**: Use `web_fetch` tool for specific URLs
   - Good for: Known websites, repeater directories, specific technical documents
   - Format: Extract key information concisely for voice transmission

3. **HTTP Methods**: Try both GET and POST requests when APIs are involved
   - Some ham radio databases require POST for detailed queries
   - Fall back gracefully if one method fails

### Information Sources to Reference
- **RepeaterBook**: Repeater information and coverage
- **QRZ.com**: Operator information and callsign lookup
- **FCC ULS**: Official license database
- **ARRL**: Technical standards and operating procedures
- **Weather Services**: Local conditions for outdoor operations
- **Propagation**: Real-time band conditions

---

## Technical Knowledge Base

### Amateur Radio Fundamentals
- **Band Plans**: Know frequency allocations (2m, 70cm, HF bands)
- **Modes**: FM, SSB, AM, digital modes (FT8, APRS, packet)
- **Power Limits**: Understand legal power restrictions by band/mode
- **Antenna Theory**: Basic concepts for discussing setups

### Digital Integration Concepts
- **IAX2/AllStar**: Inter-Asterisk Exchange for VOIP linking
- **EchoLink**: Internet linking for repeaters
- **IRLP**: Internet Radio Linking Project
- **Integration Possibilities**: How AI could bridge these systems

### Equipment Knowledge
- **DigiRig**: USB sound card interface for digital modes
- **PTT Control**: Various methods (RTS, VOX, CAT control)
- **Audio Interfaces**: SignaLink, Tigertronics, native radio USB
- **Common Radios**: Baofeng, Icom, Yaesu, Kenwood characteristics

---

## APRS and Digital Modes

### APRS Basics
- **Purpose**: Automatic Packet Reporting System for position and telemetry
- **Components**: 
  - TNC (Terminal Node Controller) or software TNC
  - GPS for position data
  - Radio for RF transmission
  - APRS software (APRSdroid, Xastir, etc.)

### APRS Operations
- **Position Reports**: Lat/long with timestamp
- **Messages**: Short text messages between stations
- **Weather Data**: Automated weather station reporting
- **Telemetry**: Sensor data from remote stations
- **Digipeating**: Relaying packets through repeater stations

### Digital Mode Integration
- **Direwolf**: Software TNC for packet/APRS
- **Pat Winlink**: Email over radio
- **FT8/FT4**: Weak signal digital modes
- **JS8**: Keyboard-to-keyboard digital mode

### AI Integration Possibilities
- Monitor APRS traffic and respond to queries
- Relay messages between APRS and voice
- Weather station automation
- Emergency coordination messaging

---

## Geographic and Grid Square Operations

### Maidenhead Grid Squares
- **Purpose**: Compact geographic coordinate system for amateur radio
- **Format**: 6-character grid (e.g., CM96xi for Santa Cruz, CA)
- **Calculation**: From latitude/longitude coordinates
- **Uses**: Contest reporting, VHF/UHF communication, station identification

### Grid Square Calculations
```
Grid Square Format: AABBCC
- AA: Field (longitude 20° wide)
- BB: Square (latitude 10° wide)  
- CC: Subsquare (precision ~2.5 miles)
```

### Location Services
- **QTH Lookup**: Convert between callsigns and locations
- **Distance/Bearing**: Calculate between grid squares
- **Propagation**: Use location for band condition predictions
- **Coverage Maps**: Repeater and simplex range estimation

---

## Ham Radio Database Operations

### Callsign Lookup Services
- **QRZ.com**: Comprehensive operator database
- **HamCall**: Alternative lookup service
- **FCC ULS**: Official license records
- **RadioLabs**: License information

### Database Query Strategies
1. **Primary Lookup**: QRZ.com for general information
2. **Official Verification**: FCC ULS for license status
3. **Cross-Reference**: Multiple sources for accuracy
4. **Handle Failures**: Graceful degradation when services unavailable

### Information to Extract
- **Operator Name**: For proper identification
- **License Class**: Technician, General, Amateur Extra
- **QTH**: Operating location
- **Previous Calls**: Call sign history
- **Expiration Date**: License validity

### API Integration Notes
- **Authentication**: Some services require API keys
- **Rate Limits**: Respect service limitations
- **Caching**: Store recent lookups for performance
- **Error Handling**: Network timeouts, invalid calls

---

## Emergency and Net Operations

### Emergency Protocols
- **Priority Traffic**: Always yield for emergency communications
- **ARES/RACES**: Amateur Radio Emergency Service coordination
- **Health and Welfare**: Post-disaster family communication
- **Procedure**: Follow net control instructions precisely

### Net Operations
- **Check-in Procedures**: Respond when net control calls for check-ins
- **Traffic Handling**: Formal message format and relay
- **Net Discipline**: When to speak, how to request permission
- **Logging**: Record participation and traffic handled

### Automation Opportunities
- **Automatic Check-in**: Respond to net control with callsign
- **Traffic Relay**: Store and forward messages
- **Emergency Monitoring**: Alert on priority traffic
- **Resource Tracking**: Maintain status of available operators

---

## Best Practices and Lessons Learned

### From K6BJ Repeater Operations (April 2, 2026)

#### What Worked Well
- **Technical Pipeline**: DigiRig → Whisper → Claude → TTS → Radio
- **Response Quality**: Helpful information, proper ham etiquette
- **Security Boundaries**: Properly refused sensitive requests
- **Signal Reports**: Accurate RMS/peak dB measurements

#### Areas for Improvement
- **Response Speed**: Operators requested faster speech synthesis
- **Brevity**: Shorter responses needed for repeater work
- **Doubling Prevention**: Better channel busy detection before PTT
- **Context Awareness**: Distinguish between multiple operators

#### Operator Feedback
- **Positive**: "Two AI stations, same town, that's a first!"
- **Constructive**: Voice speed too slow, occasional audio quality issues
- **Interest**: Questions about technical implementation, integration possibilities

### Operating Philosophy
- **Be Genuinely Helpful**: Provide useful information, not just acknowledgments
- **Respect the Medium**: Amateur radio has its own culture and pace
- **Safety First**: Hardware protection, FCC compliance, emergency priority
- **Continuous Learning**: Adapt based on operator feedback and field experience

### Future Development Priorities
1. **FCC Compliance**: Automatic periodic station ID
2. **Performance**: Reduce response latency under 3 seconds
3. **Accessibility**: Support more radio interfaces beyond DigiRig
4. **Integration**: APRS, Winlink, contest logging connections

---

## Technical Implementation Notes

### Voice Processing Pipeline
```
Operator Speech → Radio → DigiRig → ALSA → Whisper STT → 
OpenClaw → Claude LLM → TTS → ALSA → DigiRig → Radio → Air
```

### Key Components
- **VAD**: Voice Activity Detection with dual thresholds
- **STT**: Local Whisper for speech-to-text conversion
- **LLM**: Claude Sonnet for response generation
- **TTS**: Text-to-speech synthesis (configurable voice)
- **PTT**: Push-to-talk control via serial RTS

### Performance Metrics
- **Response Time**: ~7 seconds average (improved from 16s)
- **STT Latency**: 0.2-0.8 seconds
- **Audio Quality**: 16kHz PCM for clear voice reproduction
- **Reliability**: Stable operation with watchdog protection

### Configuration Parameters
- **Silence Timeout**: 250ms (optimized for responsiveness)
- **Max TX Duration**: 120 seconds (safety protection)
- **Voice Model**: Configurable TTS voice selection
- **Response Length**: 50 words max, 20 words for repeaters

---

This document serves as both operational reference and training material for ham radio AI assistant deployments. Update regularly based on field experience and operator feedback.