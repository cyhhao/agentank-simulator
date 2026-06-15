#!/usr/bin/env node

import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { AgenTankSimulator, loadIsolatedBotFromFile, parseRawMap } from "../src/index.js";

const DEFAULT_BOT_TIMEOUT_MS = 100;

const args = parseArgs(process.argv.slice(2));
if (!args.botA || !args.botB || !args.map) {
  console.error(`Usage:
  agentank-simulate-local --bot-a path/to/a.js --bot-b path/to/b.js --map 'a...|....|...A' [--skill-a teleport] [--skill-b overload] [--bot-timeout-ms 100] [--star-limit 5] [--out replay.json]`);
  process.exit(1);
}

const parsed = parseRawMap(args.map);
const botOptions = { timeoutMs: positiveNumber(args.botTimeoutMs, DEFAULT_BOT_TIMEOUT_MS, "--bot-timeout-ms") };
const botA = await loadIsolatedBotFromFile(resolve(args.botA), botOptions);
const botB = await loadIsolatedBotFromFile(resolve(args.botB), botOptions);
const sim = new AgenTankSimulator({
  map: parsed.map,
  tanks: parsed.tanks,
  skills: [args.skillA || "teleport", args.skillB || "overload"],
  maxFrames: Number(args.maxFrames || 300),
  starLimit: args.starLimit ? positiveNumber(args.starLimit, null, "--star-limit") : null,
  star: args.star ? args.star.split(",").map(Number) : null
});

let result;
try {
  result = await sim.runAsync(botA, botB);
} finally {
  botA.close();
  botB.close();
}
const summary = result.result || result.replayData.replay.meta.result;
console.log(`winner=${summary.winner ?? "draw"} reason=${summary.reason} frames=${result.replayData.replay.records.length}`);
if (args.out) {
  await writeFile(args.out, JSON.stringify(result, null, 2));
  console.log(`wrote ${args.out}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bot-a") out.botA = argv[++i];
    else if (arg === "--bot-b") out.botB = argv[++i];
    else if (arg === "--map") out.map = argv[++i];
    else if (arg === "--skill-a") out.skillA = argv[++i];
    else if (arg === "--skill-b") out.skillB = argv[++i];
    else if (arg === "--bot-timeout-ms") out.botTimeoutMs = argv[++i];
    else if (arg === "--max-frames") out.maxFrames = argv[++i];
    else if (arg === "--star-limit") out.starLimit = argv[++i];
    else if (arg === "--star") out.star = argv[++i];
    else if (arg === "--out") out.out = argv[++i];
  }
  return out;
}

function positiveNumber(value, fallback, name) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}
