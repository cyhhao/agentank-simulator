import vm from "node:vm";
import { readFile } from "node:fs/promises";

export async function loadBotFromFile(path, options = {}) {
  const code = await readFile(path, "utf8");
  return loadBotFromCode(code, options);
}

export function loadBotFromCode(code, options = {}) {
  const logs = [];
  const sandbox = {
    print: (...args) => logs.push({ type: "print", data: args.join(" ") }),
    speak: (text) => logs.push({ type: "speak", data: String(text ?? "") })
  };
  vm.createContext(sandbox, { microtaskMode: "afterEvaluate" });
  vm.runInContext(`${code}
this.__agentankOnIdle = typeof onIdle === "function" ? onIdle : null;
`, sandbox, { timeout: options.loadTimeoutMs || 1000 });
  if (typeof sandbox.__agentankOnIdle !== "function") {
    throw new Error("Bot code must define function onIdle(me, enemy, game)");
  }
  return new BotRunner(sandbox, logs, options);
}

export class BotRunner {
  constructor(sandbox, logs, options = {}) {
    this.sandbox = sandbox;
    this.logs = logs;
    this.timeoutMs = Math.max(1, Math.floor(Number(options.timeoutMs) || 20));
    this.queue = [];
    this.turnScript = new vm.Script(`
{
  globalThis.__agentankTurn = { status: "pending" };
  try {
    const result = globalThis.__agentankOnIdle(globalThis.__agentankFrame.me, globalThis.__agentankFrame.enemy, globalThis.__agentankFrame.game);
    if (result && typeof result.then === "function") {
      result.then(
        () => { globalThis.__agentankTurn = { status: "fulfilled" }; },
        (error) => { globalThis.__agentankTurn = { status: "rejected", error }; }
      );
    } else {
      globalThis.__agentankTurn = { status: "fulfilled" };
    }
  } catch (error) {
    globalThis.__agentankTurn = { status: "rejected", error };
  }
}
`);
  }

  decide(context) {
    if (this.queue.length > 0) {
      return { action: this.queue.shift(), logs: [], runtimeMs: 0, queued: true };
    }
    this.logs.length = 0;
    const actions = [];
    const me = createAgentProxy(context.me, actions, this.logs);
    const enemy = context.enemy;
    const game = context.game;
    const started = process.hrtime.bigint();
    try {
      this.sandbox.__agentankFrame = { me, enemy, game };
      this.turnScript.runInContext(this.sandbox, { timeout: this.timeoutMs });
    } catch (error) {
      this.sandbox.__agentankFrame = null;
      this.sandbox.__agentankTurn = null;
      return this.errorDecision(started, error);
    }
    const turn = this.sandbox.__agentankTurn;
    this.sandbox.__agentankFrame = null;
    this.sandbox.__agentankTurn = null;
    if (turn?.status === "rejected") return this.errorDecision(started, turn.error);
    if (turn?.status === "pending") return this.timeoutDecision(started);
    return this.finishDecision(started, actions, context.me);
  }

  finishDecision(started, actions, snapshot = {}) {
    const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (runtimeMs > this.timeoutMs) {
      return {
        action: { type: "timeout", runtimeMs },
        logs: this.logs.slice(),
        runtimeMs
      };
    }
    if (snapshot.status?.boosted && actions[0]?.type === "turn" && actions[1]?.type === "go") {
      const [, , ...queued] = actions;
      this.queue.push(...queued);
      const action = { type: "turnGo", side: actions[0].side };
      const reason = actions[0].reason || actions[1].reason;
      if (reason) action.reason = reason;
      return {
        action,
        logs: this.logs.slice(),
        runtimeMs
      };
    }
    if (snapshot.status?.boosted && actions[0]?.type === "turn" && actions[1]?.type === "fire") {
      const [, , ...queued] = actions;
      this.queue.push(...queued);
      const action = { type: "turnFire", side: actions[0].side };
      const reason = actions[0].reason || actions[1].reason;
      if (reason) action.reason = reason;
      return {
        action,
        logs: this.logs.slice(),
        runtimeMs
      };
    }
    const [action, ...queued] = actions;
    this.queue.push(...queued);
    return {
      action: action || null,
      logs: this.logs.slice(),
      runtimeMs
    };
  }

  timeoutDecision(started, error) {
    const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      action: { type: "timeout", runtimeMs },
      logs: this.logs.slice(),
      runtimeMs,
      error
    };
  }

  errorDecision(started, error) {
    if (isVmTimeout(error)) return this.timeoutDecision(started, error);
    const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      action: { type: "error", message: error?.message || String(error) },
      logs: this.logs.slice(),
      runtimeMs,
      error
    };
  }
}

function createAgentProxy(snapshot, actions, logs) {
  const reasonOf = () => agent.__actionReason || undefined;
  const withReason = (action) => {
    const reason = reasonOf();
    if (reason) action.reason = reason;
    return action;
  };
  const agent = {
    __debugActionReasonSink: true,
    tank: snapshot.tank,
    stars: snapshot.stars,
    bullet: snapshot.bullet,
    skill: snapshot.skill,
    status: snapshot.status,
    effects: snapshot.effects,
    go(count = 1) {
      const steps = Math.max(1, Math.floor(Number(count) || 1));
      for (let i = 0; i < steps; i += 1) actions.push(withReason({ type: "go" }));
    },
    turn(side) {
      actions.push(withReason({ type: "turn", side: side === "left" ? "left" : "right" }));
    },
    fire() {
      actions.push({ type: "fire", reason: agent.__actionReason || undefined });
    },
    overload() {
      actions.push(withReason({ type: "overload" }));
    },
    shield() {
      actions.push({ type: "shield" });
    },
    stun() {
      actions.push({ type: "stun" });
    },
    poison() {
      actions.push({ type: "poison" });
    },
    boost() {
      actions.push(withReason({ type: "boost" }));
    },
    cloak() {
      actions.push({ type: "cloak" });
    },
    teleport(x, y) {
      actions.push({ type: "teleport", x: Number(x), y: Number(y), reason: agent.__teleportReason || undefined });
    },
    freeze() {
      actions.push({ type: "freeze" });
    },
    throwBomb() {
      actions.push(withReason({ type: "throwBomb" }));
    },
    speak(text) {
      logs.push({ type: "speak", data: String(text ?? "") });
    },
    print(...args) {
      logs.push({ type: "print", data: args.join(" ") });
    }
  };
  for (const skill of ["overload", "cloak", "teleport", "freeze", "shield", "stun", "poison", "boost"]) {
    if (snapshot.skill?.type !== skill) delete agent[skill];
  }
  return agent;
}

function isVmTimeout(error) {
  return error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /Script execution timed out/.test(error?.message || "");
}
