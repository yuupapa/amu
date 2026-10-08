// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a temporary folder with a fake executable only.
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { findExecutable, grokHomeFolder, parseGrokDeviceLogin, runCommand } from "./GrokAuth.ts";

describe("parseGrokDeviceLogin", () => {
  it("reads the address and code once the CLI has printed them", () => {
    const output =
      "\u001b[1mOpen this link to sign in:\u001b[0m\n" +
      "  \u001b[4mhttps://accounts.x.ai/oauth2/device?user_code=ABCD-1234\u001b[0m\n" +
      "Code: ABCD-1234\n";
    expect(parseGrokDeviceLogin(output)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    });
  });

  it("waits while the address is not there yet", () => {
    expect(parseGrokDeviceLogin("Starting sign-in…\n")).toBeNull();
    expect(parseGrokDeviceLogin("https://accounts.x.ai/oauth2/device?user_code=")).toBeNull();
  });

  it("does not take a code cut between two pieces of output", () => {
    const first = "Open https://accounts.x.ai/oauth2/device?user_code=ABCD";
    expect(parseGrokDeviceLogin(first)).toBeNull();
    expect(parseGrokDeviceLogin(`${first}-1234\n`)?.userCode).toBe("ABCD-1234");
  });

  it("does not take an address on another site", () => {
    expect(
      parseGrokDeviceLogin("https://example.com/oauth2/device?user_code=ABCD-1234"),
    ).toBeNull();
  });
});

describe("findExecutable", () => {
  it("finds a command on PATH, or as given, and nothing that cannot run", () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-auth-"));
    try {
      const grok = NodePath.join(folder, "grok");
      NodeFS.writeFileSync(grok, "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(folder, "plain"), "", { mode: 0o644 });
      const environment = { PATH: `/nonexistent${NodePath.delimiter}${folder}` };
      expect(findExecutable("grok", environment)).toBe(grok);
      expect(findExecutable(grok, {})).toBe(grok);
      expect(findExecutable("plain", environment)).toBeNull();
      expect(findExecutable("missing", environment)).toBeNull();
      expect(findExecutable("grok", {})).toBeNull();
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("grokHomeFolder", () => {
  it("names the same folder the same way, however it is written", () => {
    const home = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-home-")),
    );
    try {
      const plain = grokHomeFolder({ HOME: home });
      expect(plain).toBe(NodePath.join(home, ".grok"));
      expect(grokHomeFolder({ HOME: home, GROK_HOME: NodePath.join(home, ".grok") })).toBe(plain);
      expect(grokHomeFolder({ HOME: home, GROK_HOME: "~/.grok" })).toBe(plain);
      expect(grokHomeFolder({ HOME: home, GROK_HOME: "~/other" })).toBe(
        NodePath.join(home, "other"),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runCommand", () => {
  it("stops the command's children too, and waits for them, when the flow stops", async () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-run-"));
    const pidFile = NodePath.join(folder, "child.pid");
    try {
      const program = Effect.gen(function* () {
        const fiber = yield* runCommand({
          command: "/bin/sh",
          args: ["-c", `sleep 30 & echo $! > ${pidFile}; echo started; wait`],
          environment: { PATH: "/usr/bin:/bin" },
          timeoutMs: 60_000,
        }).pipe(Effect.forkChild);
        while (!NodeFS.existsSync(pidFile) || NodeFS.readFileSync(pidFile, "utf8").trim() === "")
          yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
      });
      await Effect.runPromise(program);
      const child = Number(NodeFS.readFileSync(pidFile, "utf8").trim());
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(alive()).toBe(false);
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });

  it("passes each new piece of output along with the latest text", async () => {
    const chunks: string[] = [];
    const result = await Effect.runPromise(
      runCommand({
        command: "/bin/sh",
        args: ["-c", "printf one; printf two"],
        environment: { PATH: "/usr/bin:/bin" },
        timeoutMs: 10_000,
        onOutput: (chunk) => chunks.push(chunk),
      }),
    );
    expect(result).toEqual({ code: 0, output: "onetwo" });
    expect(chunks.join("")).toBe("onetwo");
  });
});
