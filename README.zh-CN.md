# AgenTank Simulator

[English](README.md) | [简体中文](README.zh-CN.md)

AgenTank 对战机器人的高保真本地模拟器。这个包从本地 `agentank-lab` 工作流中拆出，方便独立测试、复用和开源发布，不绑定任何具体坦克策略实验。

模拟器尽量贴近公开 replay / event 数据形态，可用于本地回归门禁、bot 对战 rollout 和规则验证。它不是官方服务端实现。

如果这个包位于 `agentank-lab` 内部，`agentank-simulator/` 就是模拟器的唯一源头；lab 里的旧 `src/simulator/` 文件只是兼容 re-export，不应该在那里修改模拟器规则。

## 安装

```bash
npm install
npm test
```

这个包没有运行时 npm 依赖。隔离执行 bot 依赖 Node.js permission model，因此需要 Node.js 22 或更新版本。

## 命令行

运行两个 bot 文件的本地对局：

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

全局安装或 `npm link` 后，也可以使用：

```bash
agentank-simulate-local --bot-a examples/walker-bot.js --bot-b examples/idle-bot.js --map 'xxxxxxxxx|xa.....x|x......x|x......x|x.....Ax|xxxxxxxxx'
```

## 作为库使用

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

## 核心文件

- `src/engine.js`：确定性的游戏状态推进。
- `src/map.js`：地图解析、地形工具和视线遮挡判断。
- `src/constants.js`：规则常量和方向工具。
- `src/bot-runner.js`：进程内 VM bot runner。
- `src/isolated-bot-runner.js`：用于不可信 bot 文件的子进程 runner。
- `src/isolated-bot-worker.mjs`：隔离执行使用的 worker 进程。
- `bin/simulate-local.mjs`：本地对局命令行入口。
- `test/check-simulator.mjs`：模拟器规则回归测试。

## 已实现范围

- 帧顺序：挑战方行动、防守方行动，然后子弹移动。
- 地图地形：石墙 (`x`)、土堆 (`m`)、草地 (`o`)、空地 (`.`)。
- 坦克动作：`go`、`turn`、`fire`、队列动作，以及 boost / turn-fire 组合回合。
- 子弹移动：每帧两格，并输出接近 replay 的事件顺序。
- 子弹和墙、土堆、坦克、护盾的碰撞。
- 土堆破坏事件。
- 星星生成和拾取。
- 基于 seed 的随机星星生成。
- 面向 bot `onIdle` 的可见性快照，包括草地和 cloak 隐藏敌方坦克。
- 敌方子弹基于当前视线可见。
- 技能：`cloak`、`overload`、`teleport`、`freeze`、`stun`、`shield`、`boost`、`poison`。
- `throwBomb` 炸弹动作。
- 时间上限和双杀时按星星数、再按运行时间判定。
- replay-like JSON 输出。
- 使用 Node permission flags 隔离执行 bot。

## 已知差异

- 官方运行时间统计仍是近似模拟。
- 官方星星生成策略可能仍有细节差异。
- 同帧双杀、子弹交叉等边界情况还需要更多官方 replay 校准。
- 尚未内置完整的官方对局 differential replay checker。

## 许可证

MIT
