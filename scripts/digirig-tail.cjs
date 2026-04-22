#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ANSI color codes for syntax highlighting
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Text colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString('en-US', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return `${colors.dim}${time}${colors.reset}`;
}

function formatCallsign(callsign) {
  if (!callsign || callsign === 'radio' || callsign === 'AI') return '';
  return `${colors.bright}${colors.cyan}${callsign}${colors.reset}`;
}

function formatSignalQuality(data) {
  if (!data.rmsDb && !data.peakDb) return '';
  
  const rms = data.rmsDb ? `RMS: ${data.rmsDb.toFixed(1)}dB` : '';
  const peak = data.peakDb ? `Peak: ${data.peakDb.toFixed(1)}dB` : '';
  const carrier = data.carrierSense !== undefined ? `Carrier: ${data.carrierSense}` : '';
  
  const parts = [rms, peak, carrier].filter(Boolean);
  if (parts.length === 0) return '';
  
  return `${colors.dim}[${parts.join(', ')}]${colors.reset}`;
}

function formatTransmissionType(type, sequence = null) {
  if (type === 'dtmf' && sequence) {
    return `${colors.bright}${colors.yellow}[DTMF: ${sequence}]${colors.reset}`;
  } else if (type === 'dtmf') {
    return `${colors.bright}${colors.yellow}[DTMF]${colors.reset}`;
  }
  return '';
}

// Track LLM-identified senders by session ID (enriched after dispatch)
const senderMap = new Map();

function formatLogEntry(line) {
  try {
    const entry = JSON.parse(line);
    const timestamp = formatTimestamp(entry.ts);
    
    if (entry.type === 'RX_SENDER') {
      // Sender enrichment from LLM — update our tracking map
      if (entry.sender && entry.sessionId != null) {
        senderMap.set(entry.sessionId, entry.sender);
      }
      return null; // Don't display separately, it enriches the RX entry
    }
    
    if (entry.type === 'RX') {
      // Use LLM-identified sender if available (from RX_SENDER or METRIC), fall back to regex
      const llmSender = entry.sender || senderMap.get(entry.sessionId);
      const regexSender = entry.text?.match(/\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/)?.[0];
      const sender = llmSender || regexSender;
      const callsign = formatCallsign(sender);
      const signal = formatSignalQuality(entry);
      const text = entry.text || '';
      
      const rxIcon = `${colors.green}📥 RX${colors.reset}`;
      const callsignPart = callsign ? ` ${callsign}:` : ':';
      const signalPart = signal ? ` ${signal}` : '';
      
      return `${timestamp} ${rxIcon}${callsignPart} ${text}${signalPart}`;
      
    } else if (entry.type === 'TX' || entry.type === 'TX_DTMF') {
      const text = entry.text || entry.sequence || '';
      const duration = entry.duration ? `${Math.round(entry.duration)}ms` : '';
      const signal = entry.audioMs ? `${Math.round(entry.audioMs)}ms` : '';
      
      const txIcon = entry.type === 'TX_DTMF' ? 
        `${colors.magenta}📤 TX${colors.reset} ${formatTransmissionType('dtmf', entry.sequence)}` :
        `${colors.magenta}📤 TX${colors.reset}`;
      
      const durationPart = duration || signal ? ` ${colors.dim}[${duration || signal}]${colors.reset}` : '';
      
      return `${timestamp} ${txIcon}: ${text}${durationPart}`;
      
    } else if (entry.type === 'METRIC') {
      // Track sender from METRIC entries too
      if (entry.sender && entry.sessionId != null) {
        senderMap.set(entry.sessionId, entry.sender);
      }
      return null;
      
    } else if (entry.type === 'RX_START') {
      return `${timestamp} ${colors.dim}${colors.green}🎙️  Receiving...${colors.reset}`;
      
    } else if (entry.type === 'RX_END') {
      const duration = entry.durationMs ? `${Math.round(entry.durationMs)}ms` : '';
      const durationPart = duration ? ` ${colors.dim}[${duration}]${colors.reset}` : '';
      return `${timestamp} ${colors.dim}${colors.green}🎙️  Reception ended${durationPart}${colors.reset}`;
      
    } else if (entry.type === 'PTT_KEY') {
      return `${timestamp} ${colors.dim}${colors.red}📡 PTT Keyed${colors.reset}`;
      
    } else if (entry.type === 'PTT_UNKEY') {
      return `${timestamp} ${colors.dim}${colors.red}📡 PTT Released${colors.reset}`;
      
    } else if (entry.type === 'ERROR') {
      return `${timestamp} ${colors.bright}${colors.red}❌ ERROR${colors.reset}: ${entry.message || entry.error || 'Unknown error'}`;
      
    } else if (entry.type === 'ENERGY') {
      // Skip energy events unless they're significant
      if (entry.rms > 0.05) {
        return `${timestamp} ${colors.dim}⚡ Energy: ${entry.rms.toFixed(3)}${colors.reset}`;
      }
      return null; // Skip low-level energy events
      
    } else {
      // Other events
      const eventName = entry.type.replace(/_/g, ' ').toLowerCase();
      return `${timestamp} ${colors.dim}📋 ${eventName}${colors.reset}`;
    }
    
  } catch (error) {
    // Not JSON or malformed - just return the raw line
    return `${colors.dim}${line}${colors.reset}`;
  }
}

const LOGS_DIR = path.join(process.env.HOME, '.openclaw', 'logs');

// Returns the newest digirig-YYYY-MM-DD.log under ~/.openclaw/logs, or null.
// Uses filename sort (lexicographic = chronological for the YYYY-MM-DD format).
function findLatestLogFile() {
  try {
    const files = fs.readdirSync(LOGS_DIR)
      .filter((f) => /^digirig-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    const last = files[files.length - 1];
    return last ? path.join(LOGS_DIR, last) : null;
  } catch {
    return null;
  }
}

function printHeader() {
  console.log(`${colors.bright}${colors.cyan}╭─────────────────────────────────────────────────────────────╮${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}│                   DigiRig Live Monitor                      │${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}╰─────────────────────────────────────────────────────────────╯${colors.reset}`);
  console.log('');
  console.log(`${colors.dim}Legend: 📥 RX (Receive) | 📤 TX (Transmit) | 🎙️  Audio Events | 📡 PTT Control${colors.reset}`);
  console.log(`${colors.dim}        ${colors.cyan}CALLSIGN${colors.reset}${colors.dim} | ${colors.yellow}[DTMF: sequence]${colors.reset}${colors.dim} | [Signal Quality]${colors.reset}`);
  console.log('');
}

// Show this many lines of history on startup and after a rotation. Enough to
// cover the last few QSOs, short enough not to flood the screen.
const HISTORY_LINES = 30;

function spawnTailProcess(logFile, { fromStart = false } = {}) {
  // -F (capital) = follow by filename; reopens the file if it's replaced or
  // truncated in place. That covers same-name rotation. We handle NEW filenames
  // (e.g. midnight date rollover) separately by watching the logs dir below.
  const nFlag = fromStart ? '+1' : String(HISTORY_LINES);
  const args = ['-F', '-n', nFlag, logFile];
  const tail = spawn('tail', args);

  let buffer = '';
  tail.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const formatted = formatLogEntry(trimmed);
      if (formatted) console.log(formatted);
    }
  });
  tail.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) process.stderr.write(`${colors.red}tail: ${msg}${colors.reset}\n`);
  });
  return tail;
}

function main() {
  const explicitLogFile = process.argv[2];
  let currentLogFile = explicitLogFile || findLatestLogFile();

  if (!currentLogFile) {
    console.error(`${colors.red}Error: No DigiRig log file found.${colors.reset}`);
    console.error(`${colors.dim}Usage: ${process.argv[1]} [log-file-path]${colors.reset}`);
    console.error(`${colors.dim}Expected: ~/.openclaw/logs/digirig-YYYY-MM-DD.log${colors.reset}`);
    process.exit(1);
  }

  if (!fs.existsSync(currentLogFile)) {
    console.error(`${colors.red}Error: Log file not found: ${currentLogFile}${colors.reset}`);
    process.exit(1);
  }

  printHeader();
  console.log(`${colors.dim}Following: ${currentLogFile}${colors.reset}`);
  console.log('');

  let tail = spawnTailProcess(currentLogFile);

  // Watch the logs directory so we can switch to a newer file when it appears
  // (e.g. midnight rollover, or a manual rotate). Skip if the user passed an
  // explicit file on the CLI — they've asked for that specific file.
  let dirWatcher = null;
  if (!explicitLogFile) {
    try {
      dirWatcher = fs.watch(LOGS_DIR, (_eventType, filename) => {
        if (!filename) return;
        if (!/^digirig-\d{4}-\d{2}-\d{2}\.log$/.test(filename)) return;
        const candidate = findLatestLogFile();
        if (!candidate || candidate === currentLogFile) return;
        // Newer file appeared. Switch.
        console.log('');
        console.log(`${colors.dim}${colors.cyan}── log rotated to ${path.basename(candidate)} ──${colors.reset}`);
        console.log('');
        tail.kill();
        currentLogFile = candidate;
        tail = spawnTailProcess(currentLogFile);
      });
    } catch (err) {
      console.error(`${colors.yellow}warning: could not watch ${LOGS_DIR} for rotations: ${err.message}${colors.reset}`);
    }
  }

  const shutdown = (signal) => {
    console.log(`\n${colors.dim}Stopping log monitor (${signal})...${colors.reset}`);
    if (dirWatcher) dirWatcher.close();
    if (tail) tail.kill();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}