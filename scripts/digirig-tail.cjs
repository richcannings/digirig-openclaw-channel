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

function formatLogEntry(line) {
  try {
    const entry = JSON.parse(line);
    const timestamp = formatTimestamp(entry.ts);
    
    if (entry.type === 'RX') {
      const callsign = formatCallsign(entry.text?.match(/\b[A-Z]+\d+[A-Z]+\b/)?.[0]);
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
      // Skip detailed metrics, but could show simplified version
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

function findLatestLogFile() {
  const logsDir = path.join(process.env.HOME, '.openclaw', 'logs');
  const today = new Date().toISOString().split('T')[0];
  const logFile = path.join(logsDir, `digirig-${today}.log`);
  
  if (fs.existsSync(logFile)) {
    return logFile;
  }
  
  // If today's file doesn't exist, find the most recent one
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith('digirig-') && f.endsWith('.log'))
      .sort()
      .reverse();
    
    if (files.length > 0) {
      return path.join(logsDir, files[0]);
    }
  } catch (error) {
    // Directory might not exist
  }
  
  return null;
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

function main() {
  const logFile = process.argv[2] || findLatestLogFile();
  
  if (!logFile) {
    console.error(`${colors.red}Error: No DigiRig log file found.${colors.reset}`);
    console.error(`${colors.dim}Usage: ${process.argv[1]} [log-file-path]${colors.reset}`);
    console.error(`${colors.dim}Expected: ~/.openclaw/logs/digirig-YYYY-MM-DD.log${colors.reset}`);
    process.exit(1);
  }
  
  if (!fs.existsSync(logFile)) {
    console.error(`${colors.red}Error: Log file not found: ${logFile}${colors.reset}`);
    process.exit(1);
  }
  
  printHeader();
  console.log(`${colors.dim}Following: ${logFile}${colors.reset}`);
  console.log('');
  
  // Use tail -f to follow the file
  const tail = spawn('tail', ['-f', logFile]);
  
  tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      const formatted = formatLogEntry(line.trim());
      if (formatted) {
        console.log(formatted);
      }
    }
  });
  
  tail.stderr.on('data', (data) => {
    console.error(`${colors.red}tail error: ${data}${colors.reset}`);
  });
  
  tail.on('close', (code) => {
    console.log(`${colors.yellow}Log monitoring stopped (exit code: ${code})${colors.reset}`);
  });
  
  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    console.log(`\n${colors.dim}Stopping log monitor...${colors.reset}`);
    tail.kill();
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}