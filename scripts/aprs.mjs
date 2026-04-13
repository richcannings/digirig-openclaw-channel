#!/usr/bin/env node
// aprs — Query and interact with APRS via findu.com.
// No dependencies. Uses built-in fetch.

const BASE = "http://www.findu.com/cgi-bin";

function parseArgs(argv) {
  const args = {
    command: null, call: null, fromcall: null, tocall: null,
    msg: null, lat: null, lon: null, grid: null, speed: null,
    course: null, alt: null, json: false, help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--help" || a === "-h") { args.help = true; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--call" && rest[i + 1]) { args.call = rest[++i]; }
    else if (a === "--fromcall" && rest[i + 1]) { args.fromcall = rest[++i]; }
    else if (a === "--tocall" && rest[i + 1]) { args.tocall = rest[++i]; }
    else if (a === "--msg" && rest[i + 1]) { args.msg = rest[++i]; }
    else if (a === "--lat" && rest[i + 1]) { args.lat = rest[++i]; }
    else if (a === "--lon" && rest[i + 1]) { args.lon = rest[++i]; }
    else if (a === "--grid" && rest[i + 1]) { args.grid = rest[++i]; }
    else if (a === "--speed" && rest[i + 1]) { args.speed = rest[++i]; }
    else if (a === "--course" && rest[i + 1]) { args.course = rest[++i]; }
    else if (a === "--alt" && rest[i + 1]) { args.alt = rest[++i]; }
    else if (!a.startsWith("--") && !args.command) { args.command = a; }
    else if (!a.startsWith("--")) {
      console.error(`Unexpected argument: ${a}`);
      process.exit(1);
    }
    else { console.error(`Unknown option: ${a}`); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`aprs — Query and interact with APRS via findu.com.

USAGE:
  aprs <command> [options]

COMMANDS:
  msg-get      Get APRS messages for a callsign
  msg-send     Send an APRS message to a callsign
  locate       Find an APRS station's position
  set-position Report your position via findu.com (requires FINDU_PASSWORD)

OPTIONS:
  --call <callsign>      Callsign to query (msg-get, locate)
  --fromcall <callsign>  Sender callsign (msg-send)
  --tocall <callsign>    Destination callsign (msg-send)
  --msg <text>           Message text, max 50 chars (msg-send)
  --lat <degrees>        Latitude in decimal degrees (set-position)
  --lon <degrees>        Longitude in decimal degrees (set-position)
  --grid <grid>          Maidenhead grid square, 6 chars (set-position, alt to lat/lon)
  --speed <value>        Speed (set-position, optional)
  --course <degrees>     Course 0-359 (set-position, optional)
  --alt <value>          Altitude (set-position, optional)
  --json                 Output results as JSON
  --help                 Show this help message

EXAMPLES:
  aprs msg-get --call N6YRC --json
  aprs msg-send --fromcall W6ABC --tocall N6YRC --msg "Hello from the repeater" --json
  aprs locate --call N6YRC --json
  aprs set-position --call W6ABC --lat 37.0 --lon -122.0 --json

ENVIRONMENT:
  FINDU_PASSWORD   Required for set-position command only.

EXIT CODES:
  0  Success
  1  Invalid arguments
  2  Network/fetch error
  3  findu.com returned an error`);
}

// --- Callsign validation ---

const CALLSIGN_RE = /^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z](-\d{1,2})?$/i;

function validateCallsign(call, label) {
  if (!call) return `${label} is required`;
  if (!CALLSIGN_RE.test(call)) return `${label} "${call}" does not look like a valid callsign`;
  return null;
}

// --- HTML parsing helpers ---

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// --- Commands ---

async function msgGet(args) {
  const err = validateCallsign(args.call, "--call");
  if (err) return fail(args, err);

  const url = `${BASE}/msg.cgi?call=${encodeURIComponent(args.call)}`;
  let html;
  try {
    const res = await fetch(url);
    html = await res.text();
  } catch (e) {
    return fail(args, `Network error: ${e.message}`, 2);
  }

  if (html.includes("Sorry, no messages found for")) {
    return ok(args, { call: args.call, messages: [], message: `No APRS messages found for ${args.call}.` });
  }

  // Parse HTML table rows
  const messages = [];
  const rowRe = /<tr\s+bgcolor[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm;
    while ((cm = cellRe.exec(match[1])) !== null) {
      cells.push(stripHtml(cm[1]).trim());
    }
    // Expected: from, to, time, [Send link], message
    if (cells.length >= 4) {
      messages.push({
        from: cells[0],
        to: cells[1],
        time: cells[2],
        message: cells[cells.length - 1],
      });
    }
  }

  const summary = messages.length > 0
    ? `Found ${messages.length} APRS message(s) for ${args.call}.`
    : `No APRS messages found for ${args.call}.`;

  return ok(args, { call: args.call, messages, message: summary });
}

async function msgSend(args) {
  const errs = [
    validateCallsign(args.fromcall, "--fromcall"),
    validateCallsign(args.tocall, "--tocall"),
    !args.msg ? "--msg is required" : null,
    args.msg && args.msg.length > 50 ? `Message too long (${args.msg.length} chars, max 50)` : null,
  ].filter(Boolean);
  if (errs.length) return fail(args, errs.join("; "));

  const params = new URLSearchParams({
    fromcall: args.fromcall,
    tocall: args.tocall,
    msg: args.msg,
  });
  const url = `${BASE}/sendmsg.cgi?${params}`;

  let html;
  try {
    const res = await fetch(url);
    html = await res.text();
  } catch (e) {
    return fail(args, `Network error: ${e.message}`, 2);
  }

  if (html.includes("message sent")) {
    return ok(args, {
      fromcall: args.fromcall,
      tocall: args.tocall,
      msg: args.msg,
      message: `APRS message sent from ${args.fromcall} to ${args.tocall}: "${args.msg}"`,
    });
  }

  // Unexpected response
  const body = stripHtml(html).trim().slice(0, 200);
  return fail(args, `Unexpected response from findu.com: ${body}`, 3);
}

async function locate(args) {
  const err = validateCallsign(args.call, "--call");
  if (err) return fail(args, err);

  // Use posit.cgi with comma=1 for CSV-like output (easier to parse)
  const positUrl = `${BASE}/posit.cgi?call=${encodeURIComponent(args.call)}&comma=1`;
  let positText;
  try {
    const res = await fetch(positUrl);
    positText = await res.text();
  } catch (e) {
    return fail(args, `Network error: ${e.message}`, 2);
  }

  // Also get the human-readable page for the location description
  const findUrl = `${BASE}/find.cgi?call=${encodeURIComponent(args.call)}`;
  let findHtml;
  try {
    const res = await fetch(findUrl);
    findHtml = await res.text();
  } catch (e) {
    findHtml = "";
  }

  // Check for no position
  if (positText.includes("no position known") || positText.includes("Sorry")) {
    return ok(args, { call: args.call, found: false, message: `No APRS position known for ${args.call}.` });
  }

  // Parse posit.cgi CSV lines. Format varies but typically:
  // callsign,YYYYMMDDHHMMSS,lat,lon,speed,course,alt,...
  const lines = positText.trim().split("\n").filter(l => l.trim());
  let lat = null, lon = null, timestamp = null, speed = null, course = null, alt = null;

  if (lines.length > 0) {
    // Take the last (most recent) line
    const last = lines[lines.length - 1];
    const parts = last.split(",");
    // Try to extract lat/lon from common positions in the CSV
    for (let i = 0; i < parts.length; i++) {
      const v = parseFloat(parts[i]);
      if (isNaN(v)) continue;
      // Latitude: -90 to 90, Longitude: -180 to 180
      if (lat === null && v >= -90 && v <= 90 && parts[i].includes(".")) {
        lat = v;
      } else if (lat !== null && lon === null && v >= -180 && v <= 180 && parts[i].includes(".")) {
        lon = v;
        break;
      }
    }
  }

  // Fallback: extract lat/lon from find.cgi HTML (MapBlast/MSN link)
  if (lat === null || lon === null) {
    // Look for coordinates in the HTML. Common patterns:
    // C=LAT%2cLON or |LAT%2cLON|
    const coordRe = /(-?\d+\.\d+)%2[cC](-?\d+\.\d+)/;
    const m = coordRe.exec(findHtml);
    if (m) {
      lat = parseFloat(m[1]);
      lon = parseFloat(m[2]);
    }
  }

  // Extract description from title or body
  let description = null;
  if (findHtml) {
    // Title format: "Position of CALL --- 6.6 miles northwest of City, ST --- Report received ..."
    const titleRe = /<title[^>]*>([\s\S]*?)<\/title>/i;
    const tm = titleRe.exec(findHtml);
    if (tm) {
      description = stripHtml(tm[1]).trim();
    }
  }

  // Extract "report received" time
  let lastHeard = null;
  if (findHtml) {
    const heardRe = /Report received\s+([\s\S]*?)(?:<|$)/i;
    const hm = heardRe.exec(findHtml);
    if (hm) {
      lastHeard = stripHtml(hm[1]).trim().replace(/\s+/g, " ").replace(/---.*/, "").trim();
    }
  }

  if (lat === null || lon === null) {
    return ok(args, {
      call: args.call,
      found: false,
      description,
      message: description || `Could not parse position for ${args.call}.`,
    });
  }

  const result = {
    call: args.call,
    found: true,
    lat,
    lon,
    description,
    lastHeard,
    message: description || `${args.call} is at ${lat}, ${lon}.`,
  };

  return ok(args, result);
}

async function setPosition(args) {
  const err = validateCallsign(args.call, "--call");
  if (err) return fail(args, err);

  const password = process.env.FINDU_PASSWORD;
  if (!password) {
    return fail(args, "FINDU_PASSWORD environment variable is required for set-position.");
  }

  const hasCoords = args.lat !== null && args.lon !== null;
  const hasGrid = args.grid !== null;
  if (!hasCoords && !hasGrid) {
    return fail(args, "Either --lat and --lon, or --grid is required.");
  }
  if (hasGrid && !/^[A-R]{2}\d{2}[A-X]{2}$/i.test(args.grid)) {
    return fail(args, `Invalid Maidenhead grid square: "${args.grid}". Expected 6 characters like CM87wj.`);
  }

  const params = new URLSearchParams({
    call: args.call,
    passwd: password,
  });
  if (hasCoords) {
    params.set("lat", args.lat);
    params.set("lon", args.lon);
  } else {
    params.set("grid", args.grid);
  }
  if (args.speed !== null) params.set("speed", args.speed);
  if (args.course !== null) params.set("course", args.course);
  if (args.alt !== null) params.set("alt", args.alt);

  const url = `${BASE}/inputpos.cgi?${params}`;
  let html;
  try {
    const res = await fetch(url);
    html = await res.text();
  } catch (e) {
    return fail(args, `Network error: ${e.message}`, 2);
  }

  if (html.includes("Error") || html.includes("Bad callsign")) {
    const body = stripHtml(html).trim().slice(0, 200);
    return fail(args, `findu.com error: ${body}`, 3);
  }

  const posDesc = hasCoords ? `${args.lat}, ${args.lon}` : `grid ${args.grid}`;
  return ok(args, {
    call: args.call,
    position: hasCoords ? { lat: parseFloat(args.lat), lon: parseFloat(args.lon) } : { grid: args.grid },
    message: `Position report sent for ${args.call} at ${posDesc}.`,
  });
}

// --- Output helpers ---

function ok(args, data) {
  data.ok = true;
  if (args.json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(data.message);
    if (data.messages) {
      for (const m of data.messages) {
        console.log(`  ${m.time}  ${m.from} -> ${m.to}  ${m.message}`);
      }
    }
  }
  process.exit(0);
}

function fail(args, error, code = 1) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error }));
  } else {
    console.error(`ERROR: ${error}`);
  }
  process.exit(code);
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);

  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  switch (args.command) {
    case "msg-get": return msgGet(args);
    case "msg-send": return msgSend(args);
    case "locate": return locate(args);
    case "set-position": return setPosition(args);
    default:
      console.error(`Unknown command: ${args.command}. Use --help for usage.`);
      process.exit(1);
  }
}

main();
