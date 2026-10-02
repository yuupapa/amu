// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - bounded JSON-lines subprocess transport owns its IPC timeout and captured child.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";

export class JevProcessBridge {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly stateDir: string;
  private readonly runnerPath: string;
  private readonly python: string;
  private readonly decisionLiveEnabled: boolean;
  private readonly integrationEnabled = false;
  constructor(stateDir: string, runnerPath: string, python: string, decisionLiveEnabled = false) {
    this.stateDir = stateDir;
    this.runnerPath = runnerPath;
    this.python = python;
    this.decisionLiveEnabled = decisionLiveEnabled;
  }
  private fail(child = this.child) {
    if (child !== this.child) return;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error("Jev接続が終了しました。結果不明の送信は再送せず状態を確認してください。"),
      );
    }
    this.pending.clear();
    this.child = null;
  }
  private start() {
    if (this.child) return this.child;
    const child = NodeChildProcess.spawn(
      this.python,
      [
        "-m",
        "jevflow.t3_bridge",
        "--state-dir",
        this.stateDir,
        ...(this.decisionLiveEnabled ? ["--allow-decision-live"] : []),
      ],
      {
        cwd: this.runnerPath,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          USER: process.env.USER,
          LANG: "en_US.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    // Stderr may include local paths or transport diagnostics; never forward it to the client/log.
    child.stderr.resume();
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id: number; result?: unknown; error?: string };
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      } catch {
        this.fail(child);
        child.kill("SIGTERM");
      }
    });
    child.once("error", () => this.fail(child));
    child.once("exit", () => this.fail(child));
    return child;
  }
  request(method: string, thread: string, args: unknown): Promise<unknown> {
    // Deployment opt-in for the former decision path cannot bypass the user's removal of Jev.
    if (!this.integrationEnabled)
      return Promise.reject(
        new Error("Jev連携は停止中です。モデルを手動で選んで送信してください。"),
      );
    const child = this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error("Jev応答が不明です。自動再送はしません。保存した作業を確認してください。"),
        );
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, thread, args })}\n`, (error) => {
        if (error) this.fail(child);
      });
    });
  }
  close() {
    this.child?.kill("SIGTERM");
    this.fail();
  }
}

export class JevBridge extends Context.Service<JevBridge, JevProcessBridge>()("t3/jev/JevBridge") {}
export const jevBridgeLayer = Layer.effect(
  JevBridge,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const bridge = new JevProcessBridge(
      `${config.stateDir}/jev`,
      process.env.T3CODE_JEV_RUNNER ?? `${config.stateDir}/jev-workflow`,
      process.env.T3CODE_JEV_PYTHON ?? "python3",
      // Deployment permission is independent of Auto/Full access. Default: no external decisions.
      false,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => bridge.close()));
    return bridge;
  }),
);
