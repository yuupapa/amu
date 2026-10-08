// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off globalTimers:off - runs the Grok and npm CLIs for an in-app sign-in, with a time limit.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ProviderAuthFlow from "./ProviderAuthFlow.ts";
import type { ProviderAuthController } from "./ProviderAuthService.ts";

/**
 * Amu: sign in to Grok from Settings → Providers (docs/user/providers-grok.md).
 * When the Grok Build CLI is missing it is installed for the whole Mac with
 * npm (`npm install -g @xai-official/grok`), the same place `grok update`
 * keeps it. Then `grok login --device-auth` runs and its address and code are
 * shown in the app; approving them in the browser finishes the sign-in. The
 * login is the CLI's own (~/.grok), shared with the terminal.
 */

export const GROK_NPM_PACKAGE = "@xai-official/grok";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** The longest terminal text the app takes (ProviderAuthInteraction in contracts). */
const TERMINAL_OUTPUT_MAX = 16_384;
/** How long a stopped command may take to close before it is killed. */
const STOP_GRACE_MS = 2_000;

/** The CLI's colours and cursor moves, which are not part of the text. */
const stripAnsi = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");

/**
 * The address and code `grok login --device-auth` prints, once both are there
 * in full: the code must be followed by more text, so an address cut between
 * two pieces of output is not taken early.
 */
export function parseGrokDeviceLogin(output: string): { url: string; userCode: string } | null {
  const text = stripAnsi(output);
  const url =
    /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9]{4,16}(?:-[A-Z0-9]{4,16})*)(?=[\s"'<>)\]])/u.exec(
      text,
    );
  if (!url) return null;
  return { url: url[0], userCode: url[1]! };
}

/**
 * The folder the CLI keeps its login in, as a stable key: GROK_HOME, else
 * ~/.grok, made absolute, so two instances that name the same folder in
 * different ways share one sign-in.
 */
export function grokHomeFolder(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const configured = environment.GROK_HOME?.trim();
  const folder = configured
    ? NodePath.resolve(home, configured.replace(/^~(?=$|\/)/u, home))
    : NodePath.join(home, ".grok");
  // The nearest folder that exists is resolved, so the key is the same before
  // and after the CLI creates the rest.
  const missing: string[] = [];
  let existing = folder;
  for (;;) {
    try {
      return NodePath.join(NodeFS.realpathSync(existing), ...missing.reverse());
    } catch {
      const parent = NodePath.dirname(existing);
      if (parent === existing) return folder;
      missing.push(NodePath.basename(existing));
      existing = parent;
    }
  }
}

/** An executable found as given, or on PATH; null when there is none. */
export function findExecutable(command: string, environment: NodeJS.ProcessEnv): string | null {
  const runnable = (file: string) => {
    try {
      NodeFS.accessSync(file, NodeFS.constants.X_OK);
      return NodeFS.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/")) return runnable(command) ? command : null;
  for (const folder of (environment.PATH ?? "").split(NodePath.delimiter).filter(Boolean)) {
    const file = NodePath.join(folder, command);
    if (runnable(file)) return file;
  }
  return null;
}

/** `output` is stdout and stderr together, as shown; `stdout` alone is for reading results. */
type Run = { code: number; output: string; stdout: string };

/**
 * Runs a command in its own process group, passing its output along. A time
 * limit or a stopped flow ends the whole group (npm's and the CLI's children
 * too) and waits until it has closed, so a new attempt does not overlap it.
 */
export function runCommand(input: {
  command: string;
  args: ReadonlyArray<string>;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Each new piece of output, and the latest text kept so far. */
  onOutput?: (chunk: string, output: string) => void;
}) {
  return Effect.callback<Run, Error>((resume) => {
    let output = "";
    let stdout = "";
    let closed = false;
    let stopping: Promise<void> | null = null;
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, name);
        else child.kill(name);
      } catch {
        // Already gone.
      }
    };
    /** Whether anything of the group is still running (a child can outlive the command). */
    const groupAlive = () => {
      if (child.pid === undefined) return !closed;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** TERM, then KILL after a moment; resolves once the whole group is gone. */
    const stop = () =>
      (stopping ??= new Promise<void>((done) => {
        signal("SIGTERM");
        const CHECK_MS = 50;
        let waited = 0;
        const check = () => {
          if (!groupAlive()) return done();
          waited += CHECK_MS;
          if (waited >= STOP_GRACE_MS) signal("SIGKILL");
          // KILL cannot be ignored; past this the group is a zombie at most.
          if (waited >= STOP_GRACE_MS + 1_000) return done();
          setTimeout(check, CHECK_MS).unref();
        };
        check();
      }));
    const take = (data: Buffer) => {
      const chunk = data.toString("utf8");
      output = (output + chunk).slice(-TERMINAL_OUTPUT_MAX);
      input.onOutput?.(chunk, output);
    };
    child.stdout.on("data", (data: Buffer) => {
      stdout = (stdout + data.toString("utf8")).slice(-TERMINAL_OUTPUT_MAX);
      take(data);
    });
    child.stderr.on("data", take);
    const timer = setTimeout(() => void stop(), input.timeoutMs);
    child.once("error", (cause) => {
      clearTimeout(timer);
      closed = true;
      resume(Effect.fail(cause));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      closed = true;
      // After a time limit, the result waits until the rest of the group is gone too.
      void (stopping ?? Promise.resolve()).then(() =>
        resume(Effect.succeed({ code: code ?? 1, output, stdout })),
      );
    });
    return Effect.promise(() => {
      clearTimeout(timer);
      return stop();
    });
  });
}

export const makeGrokAuth = Effect.fn("makeGrokAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  /** The configured CLI, "grok" by default. */
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  /** After signing in or out: refresh the provider so the app sees the change. */
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
  /** After installing the CLI: refresh the provider, so it shows as installed even if sign-in stops here. */
  readonly onInstalled: Effect.Effect<void>;
}) {
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const grokCommand = () => findExecutable(options.binaryPath || "grok", options.environment);
  const npmCommand = () => findExecutable("npm", options.environment);

  /** Where `npm install -g` puts the CLI: `npm prefix -g`/bin/grok, when it is there. */
  const grokInNpmPrefix = (npm: string) =>
    runCommand({
      command: npm,
      args: ["prefix", "-g"],
      environment: options.environment,
      timeoutMs: 30_000,
    }).pipe(
      Effect.map((prefix) =>
        prefix.code === 0 && prefix.stdout.trim()
          ? findExecutable(NodePath.join(prefix.stdout.trim(), "bin", "grok"), options.environment)
          : null,
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * The CLI is there but not where Amu looks for it (the provider's PATH or
   * binary path), so Amu could not use it after signing in.
   */
  const notOnPath = (found: string) =>
    failure(
      "start",
      `Grok Build CLI は ${found} に入っていますが、Amu から見つけられません。Grok の設定の「実行ファイルのパス」に ${found} を入れてから、もう一度押してください。`,
    );

  /** Installs the Grok Build CLI for the whole Mac, then finds it again. */
  const install = (context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      const npm = npmCommand();
      if (!npm)
        return yield* failure(
          "start",
          "Grok Build CLI を入れるための npm（Node.js）が見つかりません。Node.js を入れてから、もう一度押してください。",
        );
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      // The terminal keeps the latest text within the app's limit; the offset
      // tells it how much has been written in all, so it adds only the new part.
      let transcript = "";
      let outputOffset = 0;
      const show = (chunk: string) => {
        const text = chunk.replace(/\r?\n/gu, "\r\n");
        outputOffset += text.length;
        transcript = (transcript + text).slice(-TERMINAL_OUTPUT_MAX);
        runFork(
          context.setInteraction(
            { type: "terminal", id: "install", output: transcript, outputOffset },
            // Only shows npm's output: typing and the terminal's size are not used.
            () => Effect.void,
          ),
        );
      };
      show(`Grok Build CLI を入れています（${GROK_NPM_PACKAGE}）…\n\n`);
      const result = yield* runCommand({
        command: npm,
        args: ["install", "-g", GROK_NPM_PACKAGE],
        environment: options.environment,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onOutput: (chunk) => show(chunk),
      }).pipe(
        Effect.mapError((cause) =>
          failure("start", "Grok Build CLI を入れられませんでした。", cause),
        ),
      );
      if (result.code !== 0)
        return yield* failure(
          "start",
          "Grok Build CLI を入れられませんでした。ターミナルで npm install -g @xai-official/grok を試してください。",
        );
      const found = grokCommand();
      if (found) {
        yield* options.onInstalled;
        return found;
      }
      const fromPrefix = yield* grokInNpmPrefix(npm);
      return yield* fromPrefix
        ? notOnPath(fromPrefix)
        : failure(
            "start",
            "Grok Build CLI は入りましたが、見つけられません。Amu を再起動してから、もう一度押してください。",
          );
    });

  /**
   * The CLI Amu uses. When it is missing: an earlier install that Amu cannot
   * see is reported (installing again would not help), else it is installed.
   */
  const resolveGrok = (context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      const found = grokCommand();
      if (found) return found;
      const npm = npmCommand();
      const installed = npm ? yield* grokInNpmPrefix(npm) : null;
      if (installed) return yield* notOnPath(installed);
      return yield* install(context);
    });

  const authenticate = (_methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      const grok = yield* resolveGrok(context);
      const shown = yield* Deferred.make<{ url: string; userCode: string }>();
      const showCode = yield* Deferred.await(shown).pipe(
        Effect.flatMap(({ url, userCode }) =>
          context.setInteraction({ type: "deviceCode", id: "device", url, userCode }),
        ),
        Effect.forkScoped,
      );
      const result = yield* runCommand({
        command: grok,
        args: ["login", "--device-auth"],
        environment: options.environment,
        timeoutMs: LOGIN_TIMEOUT_MS,
        onOutput: (_chunk, output) => {
          const code = parseGrokDeviceLogin(output);
          if (code) Deferred.doneUnsafe(shown, Effect.succeed(code));
        },
      }).pipe(
        Effect.mapError((cause) =>
          failure("start", "Grok のログインを始められませんでした。", cause),
        ),
      );
      yield* Fiber.interrupt(showCode);
      if (result.code !== 0)
        return yield* failure(
          "start",
          "Grok のログインが完了しませんでした。もう一度押して、ブラウザーで承認してください。",
        );
      yield* context.verifying;
      yield* options.onChanged(true);
    });

  const logout = Effect.gen(function* () {
    const grok = grokCommand();
    if (!grok)
      return yield* failure(
        "logout",
        "Grok Build CLI が見つからないため、ログアウトできませんでした。CLI の場所を確かめてください。",
      );
    const result = yield* runCommand({
      command: grok,
      args: ["logout"],
      environment: options.environment,
      timeoutMs: 60_000,
    }).pipe(
      Effect.mapError((cause) => failure("logout", "Grok からログアウトできませんでした。", cause)),
    );
    if (result.code !== 0) return yield* failure("logout", "Grok からログアウトできませんでした。");
    yield* options.onChanged(false);
  });

  const controller: ProviderAuthController = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // The CLI keeps one login per folder (~/.grok, or GROK_HOME).
    credentialBinding: {
      owner: "provider",
      key: `grok:${grokHomeFolder(options.environment)}`,
    },
    methods: Effect.succeed([
      {
        id: "device",
        name: "Grok のアカウント",
        description: "サブスクのアカウントでログインします。",
        type: "agent",
      },
    ]),
    defaultMethodId: "device",
    authenticate,
    logout,
    timeoutMs: LOGIN_TIMEOUT_MS + INSTALL_TIMEOUT_MS,
  });
  return { controller };
});
