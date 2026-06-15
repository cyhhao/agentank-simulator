import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const WORKER_PATH = fileURLToPath(new URL("./isolated-bot-worker.mjs", import.meta.url));
const SIMULATOR_SOURCE_DIR = fileURLToPath(new URL("./", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

export async function loadIsolatedBotFromFile(path, options = {}) {
  const code = await readFile(path, "utf8");
  return IsolatedBotRunner.create(code, options);
}

export class IsolatedBotRunner {
  static async create(code, options = {}) {
    const runner = new IsolatedBotRunner(options);
    await runner.init(code, options);
    return runner;
  }

  constructor(options = {}) {
    this.timeoutMs = Math.max(1, Math.floor(Number(options.timeoutMs) || 20));
    this.hostTimeoutMs = Math.max(this.timeoutMs * 20, Math.floor(Number(options.hostTimeoutMs) || 1000));
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.child = fork(WORKER_PATH, [], {
      execArgv: [
        "--permission",
        `--allow-fs-read=${SIMULATOR_SOURCE_DIR}`,
        `--allow-fs-read=${PACKAGE_JSON}`
      ],
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    this.child.on("message", (message) => this.handleMessage(message));
    this.child.on("exit", (code, signal) => this.handleExit(code, signal));
  }

  init(code, options = {}) {
    return this.request("init", { code, options }, this.hostTimeoutMs);
  }

  decide(context) {
    if (this.closed) {
      return Promise.resolve({
        action: { type: "error", message: "isolated bot process is not running" },
        logs: [],
        runtimeMs: 0
      });
    }
    return this.request("decide", { context }, this.hostTimeoutMs);
  }

  close() {
    this.closed = true;
    if (this.child?.connected) this.child.disconnect();
    if (this.child && !this.child.killed) this.child.kill();
  }

  request(type, payload, timeoutMs) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.close();
        const timeout = {
          action: { type: "timeout", runtimeMs: timeoutMs, message: "isolated bot process did not respond" },
          logs: [],
          runtimeMs: timeoutMs
        };
        if (type === "init") reject(new Error("isolated bot process did not initialize"));
        else resolve(timeout);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      this.child.send({ id, type, ...payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        if (type === "init") this.close();
        reject(error);
      });
    });
  }

  handleMessage(message) {
    const pending = this.pending.get(message?.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      if (pending.type === "init") {
        this.close();
        pending.reject(Object.assign(new Error(message.error.message), message.error));
      } else {
        pending.resolve(errorDecision(message.error));
      }
      return;
    }
    pending.resolve(message.result);
  }

  handleExit(code, signal) {
    this.closed = true;
    const error = { message: `isolated bot process exited (${signal || code})` };
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.type === "init") pending.reject(Object.assign(new Error(error.message), error));
      else pending.resolve(errorDecision(error));
      this.pending.delete(id);
    }
  }
}

function errorDecision(error) {
  return {
    action: { type: "error", message: error.message },
    logs: [],
    runtimeMs: 0,
    error
  };
}
