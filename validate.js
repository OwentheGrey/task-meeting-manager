#!/usr/bin/env node
//
// Pre-commit validator for Task Meeting Manager (index.html).
//
// Checks:
//   1. </script> trap — literal "</script" inside the main JS block
//      would cause the HTML parser to prematurely close the tag, bricking the page.
//   2. JS syntax — extracts the main <script> block and runs node --check.
//   3. IIFE structure — verifies the script opens with (function () { and closes with })();
//   4. HTML envelope — checks DOCTYPE, closing tags, and <script id="state"> presence.
//
// Usage:
//   node validate.js                  # validates index.html in the same directory
//   node validate.js path/to/file     # validates a specific file
//
// Exit codes: 0 = pass, 1 = fail

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const target = process.argv[2] || path.join(__dirname, "index.html");
const PASS = "\x1b[32mPASS\x1b[0m";
const FAIL = "\x1b[31mFAIL\x1b[0m";
const WARN = "\x1b[33mWARN\x1b[0m";

let failures = 0;
let warnings = 0;

function pass(msg) { console.log(`  ${PASS}  ${msg}`); }
function fail(msg) { failures++; console.log(`  ${FAIL}  ${msg}`); }
function warn(msg) { warnings++; console.log(`  ${WARN}  ${msg}`); }

console.log(`\nValidating: ${target}\n`);

// ── Load file ──────────────────────────────────────────────────────────
let html;
try {
  html = fs.readFileSync(target, "utf-8");
} catch (e) {
  fail(`Cannot read file: ${e.message}`);
  process.exit(1);
}

const lines = html.split("\n");
console.log(`  File size: ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB, ${lines.length} lines\n`);

// ── Check 1: HTML envelope ─────────────────────────────────────────────
console.log("─ HTML envelope");

if (html.trimStart().startsWith("<!DOCTYPE html>")) {
  pass("DOCTYPE present");
} else {
  fail("Missing <!DOCTYPE html> at start of file");
}

if (html.trimEnd().endsWith("</html>")) {
  pass("Closing </html> tag present");
} else {
  fail("File does not end with </html>");
}

if (/<script\s+id=["']state["']\s+type=["']application\/json["']>/.test(html)) {
  pass("Embedded state <script id=\"state\"> found");
} else {
  fail("Missing <script id=\"state\" type=\"application/json\"> block");
}

if (/<script\s+type=["']application\/json["']\s+id=["']cowork-artifact-meta["']>/.test(html)) {
  pass("Artifact metadata block found");
} else {
  fail("Missing cowork-artifact-meta block");
}

// ── Check 2: Locate the main <script> block ────────────────────────────
console.log("\n─ Main script block");

let scriptStart = -1;
let scriptEnd = -1;

// Find the LAST bare <script> tag (no attributes) — that's the main JS block.
// Earlier bare <script> tags are small bootstrap scripts (e.g., theme init).
for (let i = 0; i < lines.length; i++) {
  if (/^<script>\s*$/.test(lines[i].trim())) {
    scriptStart = i;
  }
}

for (let i = lines.length - 1; i >= 0; i--) {
  if (/^<\/script>\s*$/.test(lines[i].trim()) && i > scriptStart) {
    scriptEnd = i;
    break;
  }
}

if (scriptStart === -1 || scriptEnd === -1) {
  fail("Cannot locate main <script>...</script> block");
  process.exit(1);
}

pass(`Main script block: lines ${scriptStart + 1}–${scriptEnd + 1} (${scriptEnd - scriptStart - 1} JS lines)`);

const jsLines = lines.slice(scriptStart + 1, scriptEnd);
const jsCode = jsLines.join("\n");

// ── Check 3: </script> trap ────────────────────────────────────────────
console.log("\n─ </script> trap scan");

const scriptTagPattern = /<\/script/gi;
let trapHits = [];
for (let i = 0; i < jsLines.length; i++) {
  const line = jsLines[i];
  // Allow the known-safe escape in _serializeStateForArtifact:
  //   .replace(/<\/script/gi, "<\\/script")
  if (/\.replace\(.*<\\?\/script/i.test(line)) continue;
  if (scriptTagPattern.test(line)) {
    trapHits.push({ lineNum: scriptStart + 1 + i + 1, text: line.trim() });
  }
  scriptTagPattern.lastIndex = 0;
}

if (trapHits.length === 0) {
  pass("No dangerous </script> literals found in JS code");
} else {
  fail(`Found ${trapHits.length} </script> literal(s) that would brick the page:`);
  trapHits.forEach(h => console.log(`         line ${h.lineNum}: ${h.text.substring(0, 100)}`));
}

// Scan for <!-- which triggers the HTML5 "script data escaped" state.
// The HTML parser does NOT understand JS syntax — it sees raw bytes.
// A <!-- inside a string, regex, or comment is equally dangerous.
// Safe alternative: use <\!-- in regex patterns (backslash is a no-op
// escape in JS regex but breaks the 4-char <!-- sequence for HTML).
let commentHits = [];
for (let i = 0; i < jsLines.length; i++) {
  const line = jsLines[i];
  if (/<!--/.test(line)) {
    commentHits.push({ lineNum: scriptStart + 1 + i + 1, text: line.trim() });
  }
}

if (commentHits.length === 0) {
  pass("No literal <!-- found in JS code");
} else {
  fail(`Found ${commentHits.length} <!-- literal(s) — triggers HTML5 script-data-escaped state:`);
  commentHits.forEach(h => console.log(`         line ${h.lineNum}: ${h.text.substring(0, 100)}`));
}

// Scan for <script which, when preceded by <!--, triggers the HTML5
// "script data double escaped" state — in which </script> does NOT
// close the element. Flag ALL occurrences: comments, strings, etc.
let scriptOpenHits = [];
for (let i = 0; i < jsLines.length; i++) {
  const line = jsLines[i];
  if (/<script/i.test(line)) {
    scriptOpenHits.push({ lineNum: scriptStart + 1 + i + 1, text: line.trim() });
  }
}

if (scriptOpenHits.length === 0) {
  pass("No literal <script found in JS code");
} else {
  fail(`Found ${scriptOpenHits.length} <script literal(s) — compound risk with <!-- for double-escape trap:`);
  scriptOpenHits.forEach(h => console.log(`         line ${h.lineNum}: ${h.text.substring(0, 100)}`));
}

// ── Check 4: IIFE structure ────────────────────────────────────────────
console.log("\n─ IIFE structure");

// Find the IIFE opener — may not be the first line if there's a boot error handler
let iifeOpenLine = -1;
for (let i = 0; i < Math.min(jsLines.length, 20); i++) {
  if (/^\(function\s*\(/.test(jsLines[i].trim())) { iifeOpenLine = i; break; }
}
const lastJsLine = jsLines[jsLines.length - 1].trim();

if (iifeOpenLine !== -1) {
  pass("IIFE opens with (function () {");
} else {
  fail(`Expected IIFE opener in first 20 lines, not found`);
}

if (/^\}\)\(\);?$/.test(lastJsLine)) {
  pass("IIFE closes with })();");
} else {
  fail(`Expected IIFE closer })();, got: ${lastJsLine.substring(0, 60)}`);
}

// ── Check 5: JS syntax via node --check ────────────────────────────────
console.log("\n─ JS syntax (node --check)");

const tmpFile = path.join(os.tmpdir(), `tmm-validate-${Date.now()}.js`);
try {
  fs.writeFileSync(tmpFile, jsCode, "utf-8");
  execFileSync(process.execPath, ["--check", tmpFile], { stdio: "pipe" });
  pass("JavaScript parses without syntax errors");
} catch (e) {
  const stderr = e.stderr ? e.stderr.toString() : e.message;
  // Translate temp-file line numbers back to index.html line numbers
  const adjusted = stderr.replace(
    /tmm-validate-\d+\.js:(\d+)/g,
    (_, ln) => `index.html:${parseInt(ln) + scriptStart + 1}`
  );
  fail("JavaScript syntax error:\n" + adjusted.split("\n").map(l => "         " + l).join("\n"));
} finally {
  try { fs.unlinkSync(tmpFile); } catch (_) {}
}

// ── Summary ────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(50));
if (failures === 0 && warnings === 0) {
  console.log(`\x1b[32m  All checks passed.\x1b[0m\n`);
} else if (failures === 0) {
  console.log(`\x1b[33m  Passed with ${warnings} warning(s).\x1b[0m\n`);
} else {
  console.log(`\x1b[31m  ${failures} check(s) failed` + (warnings ? `, ${warnings} warning(s)` : "") + `.\x1b[0m\n`);
}

process.exit(failures > 0 ? 1 : 0);
