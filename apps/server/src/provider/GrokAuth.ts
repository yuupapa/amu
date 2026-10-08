// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off - runs the Grok and npm CLIs for an in-app sign-in, with a time limit.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
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

/** The CLI's colours and cursor moves, which are not part of the text. */
const stripAnsi = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");

/** The address and code `grok login --device-auth` prints, once both are there. */
export function parseGrokDeviceLogin(output: string): { url: string; userCode: string } | null {
  const text = stripAnsi(output);
  const url = /https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=([A-Z0-9-]{4,32})/u.exec(text);
  if (!url) return null;
  return { url: url[0], userCode: url[1]! };
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

type Run = { code: number; output: string };

/** Runs a command, passing its output along; stopping the flow stops it. */
function runCommand(input: {
  command: string;
  args: ReadonlyArray<string>;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  onOutput?: (output: string) => void;
}) {
  return Effect.callback<Run, Error>((resume) => {
    let output = "";
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      env: input.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      input.onOutput?.(output);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs);
    child.once("error", (cause) => {
      clearTimeout(timer);
      resume(Effect.fail(cause));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resume(Effect.succeed({ code: code ?? 1, output }));
    });
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGTERM");
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
}) {
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const grokCommand = () => findExecutable(options.binaryPath || "grok", options.environment);

  /** Installs the Grok Build CLI for the whole Mac, then finds it again. */
  const install = (context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      const npm = findExecutable("npm", options.environment);
      if (!npm)
        return yield* failure(
          "start",
          "Grok Build CLI を入れるための npm（Node.js）が見つかりません。Node.js を入れてから、もう一度押してください。",
        );
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const show = (text: string) =>
        runFork(
          context.setInteraction({
            type: "terminal",
            id: "install",
            output: `Grok Build CLI を入れています（${GROK_NPM_PACKAGE}）…\r\n\r\n${text.replace(/\n/gu, "\r\n")}`,
          }),
        );
      show("");
      const result = yield* runCommand({
        command: npm,
        args: ["install", "-g", GROK_NPM_PACKAGE],
        environment: options.environment,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onOutput: show,
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
      const prefix = yield* runCommand({
        command: npm,
        args: ["prefix", "-g"],
        environment: options.environment,
        timeoutMs: 30_000,
      }).pipe(Effect.orElseSucceed(() => ({ code: 1, output: "" })));
      const fromPrefix =
        prefix.code === 0
          ? findExecutable(NodePath.join(prefix.output.trim(), "bin", "grok"), options.environment)
          : null;
      const found = grokCommand() ?? fromPrefix;
      if (!found)
        return yield* failure(
          "start",
          "Grok Build CLI は入りましたが、見つけられません。Amu を再起動してから、もう一度押してください。",
        );
      return found;
    });

  const authenticate = (_methodId: string, context: ProviderAuthFlow.ProviderAuthFlowContext) =>
    Effect.gen(function* () {
      const grok = grokCommand() ?? (yield* install(context));
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
        onOutput: (output) => {
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
    if (!grok) return;
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
    // The CLI keeps one login for this Mac user (~/.grok, or GROK_HOME).
    credentialBinding: {
      owner: "provider",
      key: `grok:${options.environment.GROK_HOME ?? "~/.grok"}`,
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
