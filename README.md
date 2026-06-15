# AgenTank Simulator

[English](README.md) | [简体中文](README.zh-CN.md)

High-fidelity local simulator for AgenTank bot matches. This package is split out from the local `agentank-lab` workflow so the simulator can be tested, reused, and published independently from tank strategy experiments.

The simulator mirrors the public replay/event shape closely enough for local regression gates, bot-vs-bot rollouts, and rule validation. It is not an official server implementation.

When this package is checked out inside `agentank-lab`, this directory is the canonical simulator source. The lab's old `src/simulator/` files are compatibility re-exports only.

## Install

```bash
npm install
npm test
```

This package has no runtime npm dependencies. It requires Node.js 22 or newer because isolated bot execution uses Node's permission model.

## CLI

Run a local match between two bot files:

```bash
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --skill-a teleport \
  --skill-b overload \
  --map 'xxxxxxxxx|xa.....x|x......x|x......x|x.....Ax|xxxxxxxxx' \
  --star 4,2 \
  --out tmp/replay.json
```

When installed globally or linked, the same command is available as:

```bash
agentank-simulate-local --bot-a examples/walker-bot.js --bot-b examples/idle-bot.js --map 'xxxxxxxxx|xa.....x|x......x|x......x|x.....Ax|xxxxxxxxx'
```

## Library Usage

```js
import { AgenTankSimulator, loadBotFromCode, openMap } from "agentank-simulator";

const sim = new AgenTankSimulator({
  map: openMap(9, 7),
  tanks: [
    { position: [1, 1], direction: "right", skillType: "teleport" },
    { position: [7, 5], direction: "left", skillType: "overload" }
  ],
  maxFrames: 300,
  starLimit: null
});

const bot = loadBotFromCode("function onIdle(me) { me.go(); }");
const idle = loadBotFromCode("function onIdle() {}");
const replay = sim.run(bot, idle);
```

## Core Files

- `src/engine.js`: deterministic game-state advancement.
- `src/map.js`: map parsing, terrain helpers, and visibility blockers.
- `src/constants.js`: rule constants and direction helpers.
- `src/bot-runner.js`: in-process VM runner for bot code.
- `src/isolated-bot-runner.js`: child-process runner for untrusted bot files.
- `src/isolated-bot-worker.mjs`: worker process used by isolated execution.
- `bin/simulate-local.mjs`: command-line match runner.
- `test/check-simulator.mjs`: local rule regression suite.

## Implemented Scope

- Frame order: challenger action, defender action, then bullets move.
- Map terrain: stone (`x`), dirt (`m`), grass (`o`), empty (`.`).
- Tank actions: `go`, `turn`, `fire`, queued actions, and combined boost/turn-fire turns.
- Bullet movement: two cells per frame with replay-like event order.
- Bullet collisions with walls, dirt, tanks, and shields.
- Dirt destruction events.
- Star creation and collection.
- Seeded random star spawning on open cells.
- Visibility snapshots for bot `onIdle`, including grass and cloak hiding enemy tanks.
- Enemy bullet visibility through current line of sight.
- Skills: `cloak`, `overload`, `teleport`, `freeze`, `stun`, `shield`, `boost`, `poison`.
- Bomb action support through `throwBomb`.
- Time-limit and double-kill ties by stars, then runtime.
- Replay-like JSON export.
- Isolated bot execution with Node permission flags.

## Known Gaps

- Exact official runtime accounting is approximate.
- Exact official star spawning policy may differ.
- Some same-frame edge cases for simultaneous kills and bullet crossings still need official replay calibration.
- Full differential replay checking against official matches is not part of this package yet.

## License

MIT
