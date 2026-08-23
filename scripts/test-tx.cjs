#!/usr/bin/env node
/**
 * DigiRig On-Air TX Beacon Test
 *
 * Sends a test speech phrase to the local OpenClaw TX API (:18089)
 * which synthesizes TTS, asserts PTT on the DigiRig, and transmits
 * RF voice over the connected radio.
 *
 * Usage:
 *   node scripts/test-tx.cjs
 *   node scripts/test-tx.cjs "W6RGC this is Boss testing DigiRig transmission"
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

function getCallsignAndAlias() {
  const configPath = path.join(process.env.HOME || "", ".openclaw", "openclaw.json");
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const callsign = cfg.channels?.digirig?.tx?.callsign || "W6RGC/AI";
      const alias = cfg.channels?.digirig?.persona?.name || "Boss";
      return { callsign, alias };
    }
  } catch (err) {
    // Ignore and use default
  }
  return { callsign: "W6RGC/AI", alias: "Boss" };
}

const customText = process.argv.slice(2).join(" ").trim();
const { callsign, alias } = getCallsignAndAlias();
const testMessage = customText || `${callsign.replace("/AI", "")}, this is ${alias} testing DigiRig radio transmission.`;

console.log(`\n📡 Transmitting Test Voice Beacon via DigiRig...`);
console.log(`   Message: "${testMessage}"\n`);

const postData = JSON.stringify({ text: testMessage });
const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 18089,
    path: "/tx/text",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    },
    timeout: 30000,
  },
  (res) => {
    let raw = "";
    res.on("data", (chunk) => (raw += chunk));
    res.on("end", () => {
      try {
        const json = JSON.parse(raw);
        if (json.ok) {
          console.log(`✅ TX Success: Transmitted ${json.chars || testMessage.length} characters.`);
          console.log(`   Check your receiving radio / handheld now to verify audio clarity.\n`);
        } else {
          console.error(`❌ TX Failed: ${json.error || raw}\n`);
          process.exit(1);
        }
      } catch (err) {
        if (res.statusCode === 200) {
          console.log(`✅ TX Output (200 OK): ${raw}\n`);
        } else {
          console.error(`❌ TX Failed (HTTP ${res.statusCode}): ${raw}\n`);
          process.exit(1);
        }
      }
    });
  }
);

req.on("error", (err) => {
  if (err.code === "ECONNREFUSED") {
    console.error(`❌ Cannot connect to TX API on http://127.0.0.1:18089.`);
    console.error(`   Is the OpenClaw gateway running?`);
    console.error(`   Try: openclaw gateway restart\n`);
  } else {
    console.error(`❌ Error: ${err.message}\n`);
  }
  process.exit(1);
});

req.on("timeout", () => {
  req.destroy();
  console.error(`❌ Request timed out waiting for TX API.\n`);
  process.exit(1);
});

req.write(postData);
req.end();
