# AgenTank Simulator

[English](README.md) | [简体中文](README.zh-CN.md)

A high-fidelity local simulator for AgenTank bot matches. It runs two JavaScript tank programs against each other without calling the AgenTank platform, produces replay-like JSON, and exposes the same core engine as a library for tests, regression gates, and bot training loops.

The simulator is designed for fast local iteration:

- run two tank code files locally;
- generate deterministic random maps from a seed;
- replay fixed map strings copied from tests or reports;
- inspect frame events, star collection, crashes, bullets, bombs, skills, runtime, and winner metadata;
- load bot code in a VM or in isolated child processes.

It is not an official server implementation. The known gaps are listed near the end of this document.

## Requirements

- Node.js 22 or newer.
- No runtime npm dependencies.

Node 22 is required because isolated bot execution uses Node's permission model.

## Install

```bash
npm install
npm test
```

Run the CLI directly from this repository:

```bash
node bin/simulate-local.mjs --help
```

If the package is globally installed or linked, use:

```bash
agentank-simulate-local --help
```

## Bot Code Format

A tank file must define a global `onIdle(me, enemy, game)` function:

```js
function onIdle(me, enemy, game) {
  if (enemy.tank && enemy.tank.position[1] === me.tank.position[1]) {
    me.fire();
    return;
  }
  me.go();
}
```

The bot runner calls `onIdle` when the tank is ready for a new command. Bot methods push actions into the local action queue.

Common methods:

- `me.go(count = 1)`
- `me.turn("left" | "right")`
- `me.fire()`
- `me.throwBomb()`
- `me.speak(text)`
- `me.print(...args)`

Skill methods are only exposed when the tank owns that skill:

- `me.cloak()`
- `me.overload()`
- `me.teleport(x, y)`
- `me.freeze()`
- `me.stun()`
- `me.shield()`
- `me.boost()`
- `me.poison()`

Snapshot fields include:

- `me.tank`, `enemy.tank`: visible tank state or `null`.
- `me.stars`, `enemy.stars`.
- `me.bullet`, `enemy.bullet`: visible bullet state or `null`.
- `me.skill`, `enemy.skill`: type, cooldown, and active duration metadata.
- `me.status`, `enemy.status`: booleans such as `cloaked`, `overloaded`, `fireLocked`, `bombActive`, `frozen`, `stunned`, `poisoned`, `boosted`, `shielded`.
- `me.effects`, `enemy.effects`: active self/debuff effects.
- `game.frames`.
- `game.star`: current star position or `null`.
- `game.map`: terrain grid.
- `game.bombs`: visible bombs.

## Run Two Tank Files On A Fixed Map

Use `--bot-a` and `--bot-b` to point at two JavaScript tank files. Use `--map` for a compact map string.

```bash
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --skill-a teleport \
  --skill-b overload \
  --map 'xxxxxxxxx|xa.....x|x......x|x......x|x.....Ax|xxxxxxxxx' \
  --star 4,2 \
  --max-frames 300 \
  --out tmp/replay.json
```

Map string format:

- Rows are separated by `|`.
- `x` is stone wall.
- `m` is dirt wall.
- `o` is grass.
- `.` is empty.
- Lowercase `a`, `b`, `c`, `d` place player A facing up, right, down, left.
- Uppercase `A`, `B`, `C`, `D` place player B facing up, right, down, left.

Example:

```text
xxxxxxxxx
xa.....x
x......x
x......x
x.....Ax
xxxxxxxxx
```

The CLI prints a one-line result summary. If `--out` is provided, it writes replay-like JSON.

## Generate A Random Map And Simulate

Use `--random-map` instead of `--map`:

```bash
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --skill-a teleport \
  --skill-b cloak \
  --random-map \
  --width 19 \
  --height 15 \
  --seed 880001 \
  --max-frames 300 \
  --out tmp/random-replay.json
```

Random maps are deterministic for the same `--seed`, `--width`, and `--height`. The generator creates a stone border, mirrored dirt/grass terrain, two tank starts, and an initial star. The CLI prints the generated `map=` string and `star=` position so the same match setup can be copied into a fixed-map run.

Useful pattern:

```bash
# First, discover a seeded random setup.
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --random-map \
  --seed 42 \
  --max-frames 20

# Then copy the printed map/star into a fixed regression command.
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --map '<printed-map>' \
  --star '<printed-star>'
```

## CLI Options

Required:

- `--bot-a <path>`: player A tank file.
- `--bot-b <path>`: player B tank file.
- Either `--map <raw-map>` or `--random-map`.

Match setup:

- `--skill-a <skill>`: player A skill. Default: `teleport`.
- `--skill-b <skill>`: player B skill. Default: `overload`.
- `--star x,y`: initial star position. If omitted on a random map, the random scenario supplies one.
- `--max-frames <n>`: frame limit. Default: `300`.
- `--star-limit <n>`: optional early win threshold. By default there is no star-limit win; matches end by crash or frame-limit tiebreak.

Random map:

- `--random-map`: generate a seeded random map.
- `--width <n>`: random map width. Default: `19`.
- `--height <n>`: random map height. Default: `15`.
- `--seed <n>`: random seed for map generation and simulator RNG.

Execution and output:

- `--bot-timeout-ms <n>`: per-turn bot timeout. Default: `100`.
- `--out <path>`: write replay-like JSON.

## Library Usage

Fixed map:

```js
import { AgenTankSimulator, loadBotFromCode, parseRawMap } from "agentank-simulator";

const parsed = parseRawMap("xxxxxxx|xa...Ax|xxxxxxx");
const sim = new AgenTankSimulator({
  map: parsed.map,
  tanks: parsed.tanks,
  skills: ["teleport", "overload"],
  maxFrames: 300,
  starLimit: null,
  star: [3, 1]
});

const botA = loadBotFromCode("function onIdle(me) { me.go(); }");
const botB = loadBotFromCode("function onIdle() {}");
const replay = sim.run(botA, botB);
```

Random map:

```js
import {
  AgenTankSimulator,
  createRandomScenario,
  loadBotFromCode,
  serializeRawMap
} from "agentank-simulator";

const scenario = createRandomScenario({ width: 19, height: 15, seed: 880001 });
console.log(serializeRawMap(scenario.map, scenario.tanks), scenario.star);

const sim = new AgenTankSimulator({
  seed: 880001,
  map: scenario.map,
  tanks: scenario.tanks,
  skills: ["teleport", "cloak"],
  star: scenario.star,
  maxFrames: 300
});

const botA = loadBotFromCode("function onIdle(me) { me.go(); }");
const botB = loadBotFromCode("function onIdle(me) { me.turn('left'); }");
const replay = sim.run(botA, botB);
```

Untrusted tank files:

```js
import { AgenTankSimulator, loadIsolatedBotFromFile, parseRawMap } from "agentank-simulator";

const parsed = parseRawMap("xxxxxxx|xa...Ax|xxxxxxx");
const botA = await loadIsolatedBotFromFile("bot-a.js", { timeoutMs: 100 });
const botB = await loadIsolatedBotFromFile("bot-b.js", { timeoutMs: 100 });

try {
  const sim = new AgenTankSimulator({ map: parsed.map, tanks: parsed.tanks });
  const replay = await sim.runAsync(botA, botB);
} finally {
  botA.close();
  botB.close();
}
```

## Replay Output

`sim.run(...)`, `sim.runAsync(...)`, and the CLI `--out` file return the same shape:

```js
{
  replayData: {
    map: {
      map: "... column-major terrain grid ...",
      initialStar: [x, y]
    },
    replay: {
      records: [
        [
          { type: "tank", action: "go", objectId: "tank1", position: [2, 1] },
          { type: "bullet", action: "go", objectId: "b0000001", order: 0 }
        ]
      ],
      meta: {
        players: [
          { tank: { id: "tank1", position: [1, 1], direction: "right" }, runTime: 1.2 },
          { tank: { id: "tank2", position: [5, 1], direction: "left" }, runTime: 0.8 }
        ],
        result: { winner: 0, reason: "crashed" }
      }
    }
  },
  result: { winner: 0, reason: "crashed" }
}
```

Common event families:

- `tank`: `go`, `turn`, `crashed`.
- `bullet`: `created`, `go`, `crashed`.
- `skill`: `cast`, `applied`, `expired`.
- `star`: `created`, `collected`.
- `map`: `destroyed` for dirt.
- `bomb`: `created`, `exploded`.
- `speech`: bot `speak(...)` logs.

## Simulated Rules

Frame and actions:

- Each frame resolves player A action, player B action, then bullet movement.
- `go`, `turn`, `fire`, `throwBomb`, and skills are single actions.
- Action queues are supported by the bot runner.
- `turn(); fire();` in one `onIdle` call is queued as two actions across frames, except while boosted, where it resolves as a same-frame `turnFire`.
- While boosted, `turn(); go();` is compacted into `turnGo`.

Terrain:

- `x` stone blocks movement, bullets, bomb blast, and sight lines.
- `m` dirt blocks movement, bullets, bomb blast, and sight lines; bullets and bombs can destroy it.
- `o` grass does not block movement or bullets, but hides tanks and grass bombs from the opponent.
- `.` empty cells are open.

Bullets and firing:

- A bullet moves two cells per frame.
- A tank cannot fire another normal bullet while its previous bullet is still active.
- Bullets can hit walls, dirt, tanks, and shielded tanks.
- Dirt is destroyed when hit.
- Enemy bullets are only visible inside the observer's forward 90-degree vision cone, and stone, dirt, and grass block that bullet sight.

Stars and results:

- Stars are collected by occupying their cell.
- The default simulator has no `5 star` early win. Use `--star-limit` to opt in.
- Frame-limit games are decided by stars, then lower runtime.
- Double-crash ties use the same star/runtime tiebreak.

Skills:

- `overload`: arms a temporary self effect; the next fire creates a spread shot.
- `cloak`: hides the tank from the opponent while active.
- `teleport`: moves immediately to a legal target, consumes cooldown on illegal targets, cannot land on tanks or bullets, and lands adjacent when targeting a star.
- `freeze`: applies a short enemy debuff that prevents controlled actions.
- `stun`: applies a debuff that can reverse turns or movement.
- `shield`: blocks two incoming bullet hits before expiring. Bomb hits still consume the shield.
- `boost`: makes one executed `go()` move up to two cells, stopping at blockers.
- `poison`: slows the target action cadence.

Bombs:

- `throwBomb` places a bomb on the current tile.
- Bombs have a fuse and then explode in a cross pattern.
- Stone blocks blast propagation; dirt is destroyed and stops that ray.
- Grass bombs are hidden from the opponent.

Runtime and isolation:

- Bot runtime is accumulated and used as a tiebreaker after stars.
- `loadBotFromCode` runs code in a Node VM context.
- `loadIsolatedBotFromFile` runs bot code in a child process with Node permission flags and should be preferred for untrusted files.

## Public API

Main exports:

- `AgenTankSimulator`
- `loadBotFromCode(code, options)`
- `loadBotFromFile(path, options)`
- `loadIsolatedBotFromFile(path, options)`
- `createRandomScenario(options)`
- `serializeRawMap(map, tanks)`
- `parseRawMap(rawMap)`
- `openMap(width, height)`
- `mapFromRows(rows)`
- `cloneMap(map)`
- constants such as `DIRECTIONS`, `SKILL_COOLDOWN_FRAMES`, `SKILL_DURATION_FRAMES`.

Subpath exports:

- `agentank-simulator/engine`
- `agentank-simulator/map`
- `agentank-simulator/random-map`
- `agentank-simulator/bot-runner`
- `agentank-simulator/isolated-bot-runner`
- `agentank-simulator/constants`

## Core Files

- `src/engine.js`: deterministic game-state advancement.
- `src/map.js`: map parsing, terrain helpers, and visibility blockers.
- `src/random-map.js`: deterministic random map/scenario generation.
- `src/constants.js`: rule constants and direction helpers.
- `src/bot-runner.js`: in-process VM runner for bot code.
- `src/isolated-bot-runner.js`: child-process runner for untrusted bot files.
- `src/isolated-bot-worker.mjs`: worker process used by isolated execution.
- `bin/simulate-local.mjs`: command-line match runner.
- `test/check-simulator.mjs`: local rule regression suite.

## Known Gaps

- Exact official runtime accounting is approximate.
- Exact official star spawning policy may differ.
- Some same-frame edge cases for simultaneous kills and bullet crossings still need official replay calibration.
- Full differential replay checking against official matches is not part of this package yet.
- Random map generation is a deterministic local stress generator, not a claim to match the platform's random map distribution exactly.

## License

MIT
