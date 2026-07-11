# AgenTank Simulator

[English](README.md) | [简体中文](README.zh-CN.md)

AgenTank 对战机器人的高保真本地模拟器。它可以在本地运行两个 JavaScript 坦克程序，不调用 AgenTank 平台接口，输出 replay-like JSON，并把同一个核心引擎作为库暴露给测试、回归门禁和 bot 训练循环。

这个模拟器适合快速本地迭代：

- 本地运行两个坦克代码文件；
- 根据 seed 生成确定性的随机地图；
- 复现测试或报告里的固定地图字符串；
- 检查每帧事件、星星拾取、撞毁、子弹、炸弹、技能、运行时间和胜负信息；
- 在 VM 或隔离子进程里加载 bot 代码。

它不是官方服务端实现。已知差异列在文档末尾。

## 环境要求

- Node.js 22 或更新版本。
- 没有运行时 npm 依赖。

需要 Node 22 是因为隔离执行 bot 使用了 Node permission model。

## 安装

```bash
npm install
npm test
```

在仓库内直接运行 CLI：

```bash
node bin/simulate-local.mjs --help
```

全局安装或 `npm link` 后可以运行：

```bash
agentank-simulate-local --help
```

## 坦克代码格式

坦克文件必须定义全局 `onIdle(me, enemy, game)` 函数：

```js
function onIdle(me, enemy, game) {
  if (enemy.tank && enemy.tank.position[1] === me.tank.position[1]) {
    me.fire();
    return;
  }
  me.go();
}
```

bot runner 会在坦克准备接收新命令时调用 `onIdle`。`me` 上的方法会把动作加入本地动作队列。

通用方法：

- `me.go(count = 1)`
- `me.turn("left" | "right")`
- `me.fire()`
- `me.throwBomb()`
- `me.speak(text)`
- `me.print(...args)`

技能方法只会在坦克拥有对应技能时暴露：

- `me.cloak()`
- `me.overload()`
- `me.teleport(x, y)`
- `me.freeze()`
- `me.stun()`
- `me.shield()`
- `me.boost()`
- `me.poison()`

快照字段包括：

- `me.tank`、`enemy.tank`：可见坦克状态，或 `null`。
- `me.stars`、`enemy.stars`。
- `me.bullet`、`enemy.bullet`：可见子弹状态，或 `null`。
- `me.skill`、`enemy.skill`：技能类型、冷却和持续时间信息。
- `me.status`、`enemy.status`：`cloaked`、`overloaded`、`fireLocked`、`bombActive`、`frozen`、`stunned`、`poisoned`、`boosted`、`shielded` 等布尔状态。
- `me.effects`、`enemy.effects`：自身效果和 debuff。
- `game.frames`。
- `game.star`：当前星星坐标，或 `null`。
- `game.map`：地形网格。
- `game.bombs`：可见炸弹。

## 在固定地图上运行两个坦克文件

用 `--bot-a` 和 `--bot-b` 指定两个 JavaScript 坦克文件，用 `--map` 传入紧凑地图字符串。

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

地图字符串格式：

- 行之间用 `|` 分隔。
- `x` 是石墙。
- `m` 是土堆。
- `o` 是草地。
- `.` 是空地。
- 小写 `a`、`b`、`c`、`d` 放置玩家 A，方向分别是上、右、下、左。
- 大写 `A`、`B`、`C`、`D` 放置玩家 B，方向分别是上、右、下、左。

示例：

```text
xxxxxxxxx
xa.....x
x......x
x......x
x.....Ax
xxxxxxxxx
```

CLI 会打印一行胜负摘要。如果提供 `--out`，会写出 replay-like JSON。

## 生成随机地图并模拟

用 `--random-map` 替代 `--map`：

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

同样的 `--seed`、`--width`、`--height` 会生成同一张随机地图。生成器会创建石墙边界、镜像土堆/草地、双方出生点和初始星星。CLI 会打印生成的 `map=` 字符串和 `star=` 坐标，方便复制到固定地图命令里复现。

常用流程：

```bash
# 先发现一个 seeded 随机场景。
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --random-map \
  --seed 42 \
  --max-frames 20

# 再把输出的 map/star 复制到固定回归命令里。
node bin/simulate-local.mjs \
  --bot-a examples/walker-bot.js \
  --bot-b examples/idle-bot.js \
  --map '<printed-map>' \
  --star '<printed-star>'
```

## CLI 参数

必填：

- `--bot-a <path>`：玩家 A 坦克文件。
- `--bot-b <path>`：玩家 B 坦克文件。
- `--map <raw-map>` 或 `--random-map` 二选一。

对局设置：

- `--skill-a <skill>`：玩家 A 技能。默认 `teleport`。
- `--skill-b <skill>`：玩家 B 技能。默认 `overload`。
- `--star x,y`：初始星星坐标。随机地图不传时由随机场景提供。
- `--max-frames <n>`：帧上限。默认 `300`。
- `--star-limit <n>`：可选的星星早胜阈值。默认没有星星早胜，对局由撞毁或帧上限 tiebreak 结束。

随机地图：

- `--random-map`：生成 seeded 随机地图。
- `--width <n>`：随机地图宽度。默认 `19`。
- `--height <n>`：随机地图高度。默认 `15`。
- `--seed <n>`：地图生成和模拟器 RNG 使用的 seed。

执行和输出：

- `--bot-timeout-ms <n>`：单回合 bot 超时。默认 `100`。
- `--out <path>`：写出 replay-like JSON。

## 作为库使用

固定地图：

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

随机地图：

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

不可信坦克文件：

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

## Replay 输出

`sim.run(...)`、`sim.runAsync(...)` 和 CLI `--out` 文件返回同一种结构：

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

常见事件类型：

- `tank`：`go`、`turn`、`crashed`。
- `bullet`：`created`、`go`、`crashed`。
- `skill`：`cast`、`applied`、`failed`（例如 `reason: "cooldown"`）、`expired`。
- `star`：`created`、`collected`。
- `map`：土堆 `destroyed`。
- `bomb`：`created`、`exploded`。
- `speech`：bot `speak(...)` 日志。

## 已模拟规则

帧和动作：

- 每帧先结算玩家 A 动作，再结算玩家 B 动作，然后移动子弹。
- `go`、`turn`、`fire`、`throwBomb` 和技能都是单动作。
- bot runner 支持动作队列。
- 非 boost 状态下，动作队列每帧只执行一个动作；例如同一次 `onIdle` 里的 `turn(); fire();` 会分帧执行。
- freeze 只会暂停动作队列，不会丢弃已经排队的命令；冻结结束后继续执行。
- boost 状态下，同一次 `onIdle` 里 `turn(); fire();` 会合并为同帧 `turnFire`，`turn(); go();` 会合并为 `turnGo`。

地形：

- `x` 石墙阻挡移动、子弹、炸弹爆炸和视线。
- `m` 土堆阻挡移动、子弹、炸弹爆炸和视线；子弹和炸弹可以破坏它。
- `o` 草地不阻挡移动或子弹，但会隐藏坦克和草地炸弹。
- `.` 空地可通行。

子弹和开火：

- 子弹每帧移动两格。
- 普通子弹未消失前，同一坦克不能再次普通开火。
- 子弹可以击中墙、土堆、坦克和开盾坦克。
- 土堆被击中后会被破坏。
- 敌方子弹只在观察者朝向的前方 90 度视锥内可见，并且石墙、土堆、草地都会遮挡这条子弹视线。

星星和胜负：

- 坦克占据星星格时拾取星星。
- 默认没有 `5 星` 早胜。需要早胜时显式传 `--star-limit`。
- 帧上限结束时先比星星数，再比运行时间。
- 双方同帧撞毁时也用星星数和运行时间 tiebreak。

技能：

- `overload`：进入短时自身效果；下一次开火产生散射子弹。
- `cloak`：生效期间让敌方看不见坦克。
- `teleport`：立即移动到合法目标；非法目标也消耗冷却；不能落在坦克或子弹上；传送到星星时落在相邻格。
- `freeze`：让敌方 2 帧无法行动，但不丢弃已排队命令；冷却为 29 帧。
- `stun`：给敌方 debuff，可能反转转向或移动。
- `shield`：阻挡两次子弹命中后失效；炸弹命中仍会消耗护盾。
- `boost`：一次实际执行的 `go()` 最多移动两格，遇阻停止。
- `poison`：降低目标行动频率。

炸弹：

- `throwBomb` 在当前位置放置炸弹。
- 炸弹有引信，到时按十字形爆炸。
- 石墙阻挡爆炸传播；土堆会被破坏并阻断该方向爆炸。
- 草地里的炸弹对敌方隐藏。

运行时间和隔离：

- bot 运行时间会累计，并在星星数相同时作为 tiebreak。
- `loadBotFromCode` 在 Node VM context 中运行代码。
- `loadIsolatedBotFromFile` 使用带 Node permission flags 的子进程运行 bot，更适合不可信文件。

## Public API

主要导出：

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
- `DIRECTIONS`、`SKILL_COOLDOWN_FRAMES`、`SKILL_DURATION_FRAMES` 等常量。

子路径导出：

- `agentank-simulator/engine`
- `agentank-simulator/map`
- `agentank-simulator/random-map`
- `agentank-simulator/bot-runner`
- `agentank-simulator/isolated-bot-runner`
- `agentank-simulator/constants`

## 核心文件

- `src/engine.js`：确定性的游戏状态推进。
- `src/map.js`：地图解析、地形工具和视线遮挡判断。
- `src/random-map.js`：确定性随机地图/场景生成。
- `src/constants.js`：规则常量和方向工具。
- `src/bot-runner.js`：进程内 VM bot runner。
- `src/isolated-bot-runner.js`：用于不可信 bot 文件的子进程 runner。
- `src/isolated-bot-worker.mjs`：隔离执行使用的 worker 进程。
- `bin/simulate-local.mjs`：本地对局命令行入口。
- `test/check-simulator.mjs`：模拟器规则回归测试。

## 已知差异

- 官方运行时间统计仍是近似模拟。
- 官方星星生成策略可能仍有细节差异。
- 同帧双杀、子弹交叉等边界情况还需要更多官方 replay 校准。
- 尚未内置完整的官方对局 differential replay checker。
- 随机地图生成器是确定性的本地压力测试生成器，不声明完全匹配平台 random 地图分布。

## 许可证

MIT
