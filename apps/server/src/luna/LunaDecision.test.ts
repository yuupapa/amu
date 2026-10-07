// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - offline executable fixture uses temporary files only; the real-CLI check needs a kill timer.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import {
  acceptJudgeEvent,
  checkJudgeCli,
  judgeArgs,
  LUNA_REQUEST_TTL_MS,
  LunaDecisionBroker,
} from "./LunaDecision.ts";
import type { AutoChoice } from "@t3tools/shared/lunaAuto";
import catalog from "./lunaJudgeCatalog.json" with { type: "json" };
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { runLunaJudge } from "./LunaDecision.ts";
const choices: AutoChoice[] = [
  {
    model: "gpt-6-luna",
    name: "Luna",
    driver: "codex",
    instanceId: "codex",
    effortId: "reasoningEffort",
    efforts: ["low"],
  },
];
const decision = { model: "gpt-6-luna", effort: "low", reason: "簡単な依頼のため" };
const input = {
  prompt: "架空の挨拶文",
  choices,
  runtime: { binary: "/fixture-only", home: "", environment: {} },
};
const NOW = Date.UTC(2026, 9, 8);
const lunaId = (suffix: string, at = NOW) => `luna-${at}-${suffix}-0000-0000`;
const id = lunaId("fixed");
describe("decision-only Luna broker", () => {
  it("runs the real transport against an offline CLI fixture, validates final JSON and strips API credentials", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-luna-fixture-"));
    const binary = NodePath.join(directory, "fixture-cli"),
      receipt = NodePath.join(directory, "receipt.json");
    try {
      await NodeFSP.writeFile(
        binary,
        `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);const output=a[a.indexOf('--output-last-message')+1];let prompt='';process.stdin.on('data',b=>prompt+=b);process.stdin.on('end',()=>{const catalogArg=a.find(v=>v.startsWith('model_catalog_json='));const catalog=JSON.parse(fs.readFileSync(JSON.parse(catalogArg.split('=').slice(1).join('=')),'utf8'));fs.writeFileSync(process.env.FIXTURE_RECEIPT,JSON.stringify({args:a,catalog,prompt:JSON.parse(prompt),apiKeyPresent:!!process.env.OPENAI_API_KEY,codexKeyPresent:!!process.env.CODEX_API_KEY,home:process.env.CODEX_HOME}));fs.writeFileSync(output,JSON.stringify(${JSON.stringify(decision)}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message'}}));});\n`,
        { mode: 0o755 },
      );
      expect(
        await runLunaJudge({
          ...input,
          signal: new AbortController().signal,
          runtime: {
            binary,
            home: "/fixture-existing-home",
            environment: {
              PATH: process.env.PATH,
              FIXTURE_RECEIPT: receipt,
              OPENAI_API_KEY: "fixture-must-not-forward",
              CODEX_API_KEY: "fixture-must-not-forward",
            },
          },
        }),
      ).toEqual(decision);
      const result = JSON.parse(await NodeFSP.readFile(receipt, "utf8"));
      expect(result.apiKeyPresent).toBe(false);
      expect(result.codexKeyPresent).toBe(false);
      expect(result.home).toBe("/fixture-existing-home");
      expect(result.prompt.request).toBe(input.prompt);
      expect(result.prompt.available[0].efforts).toEqual(["low"]);
      expect(result.catalog.models[0].apply_patch_tool_type).toBeNull();
      expect(result.args).toContain("--ignore-user-config");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
  it("returns the validated fixture without retrying an existing request", async () => {
    const judge = vi.fn(async () => decision),
      broker = new LunaDecisionBroker(judge, () => NOW);
    expect(await broker.decide(id, input)).toEqual(decision);
    await expect(broker.decide(id, input)).rejects.toThrow("開始済み");
    expect(judge).toHaveBeenCalledOnce();
    broker.close();
  });
  it("rejects invalid output and never substitutes another model", async () => {
    const judge = vi.fn(async () => ({ ...decision, model: "other" })),
      broker = new LunaDecisionBroker(judge, () => NOW);
    await expect(broker.decide(id, input)).rejects.toThrow();
    await expect(broker.decide(id, input)).rejects.toThrow();
    expect(judge).toHaveBeenCalledOnce();
    broker.close();
  });
  it("records cancellation even if the decide request has not reached the server", async () => {
    const judge = vi.fn(async () => decision),
      broker = new LunaDecisionBroker(judge, () => NOW);
    broker.cancel(id);
    await expect(broker.decide(id, input)).rejects.toThrow();
    expect(judge).not.toHaveBeenCalled();
    broker.close();
  });
  it("rejects a late result after cancellation", async () => {
    let release!: (v: typeof decision) => void;
    const judge = vi.fn(
        () =>
          new Promise<typeof decision>((resolve) => {
            release = resolve;
          }),
      ),
      broker = new LunaDecisionBroker(judge, () => NOW);
    const pending = broker.decide(id, input);
    broker.cancel(id);
    release(decision);
    await expect(pending).rejects.toThrow("取り消");
    expect(judge).toHaveBeenCalledOnce();
    broker.close();
  });
  it.each([
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "request_user_input",
    "unknown_tool",
  ])("rejects %s events", (type) => {
    expect(() => acceptJudgeEvent({ type: "item.started", item: { type } })).toThrow("判断以外");
  });
  it("permits text output only and rejects provider failure", () => {
    expect(() =>
      acceptJudgeEvent({ type: "item.completed", item: { type: "agent_message" } }),
    ).not.toThrow();
    expect(() => acceptJudgeEvent({ type: "turn.failed" })).toThrow("利用できません");
  });
  it("treats CLI warnings and reconnect notices as diagnostics, not work", () => {
    expect(() =>
      acceptJudgeEvent({ type: "item.completed", item: { type: "error" } }),
    ).not.toThrow();
    expect(() => acceptJudgeEvent({ type: "error", message: "Reconnecting... 1/5" })).not.toThrow();
  });
  it("uses the fixed subscription model, JSON Schema and readonly sandbox without overriding the built-in provider", () => {
    const args = judgeArgs(
      "/fixture-schema",
      "/fixture-output",
      "/fixture-instructions",
      "/fixture-catalog",
    );
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6-luna");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).toContain("--output-schema");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain("features.shell_tool=false");
    expect(args.some((a) => a.startsWith("model_providers."))).toBe(false);
    expect(args).not.toContain("--full-auto");
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: "gpt-6-luna",
      shell_type: "disabled",
      apply_patch_tool_type: null,
      experimental_supported_tools: [],
    });
  });
});

const installedCodex = NodeChildProcess.spawnSync("codex", ["--version"], { encoding: "utf8" });
describe.skipIf(installedCodex.status !== 0)(
  "installed Codex CLI accepts the judge arguments",
  () => {
    // No credentials: empty CODEX_HOME, and the process is killed at turn.started, so no model call can succeed.
    it("passes the post-update check used after CLI updates", async () => {
      expect(await checkJudgeCli("codex", process.env)).toEqual({ ok: true });
    });
    it("fails the post-update check for a CLI that cannot start", async () => {
      expect(await checkJudgeCli("/nonexistent/codex", process.env)).toMatchObject({ ok: false });
    });
    it("reaches turn.started without config errors or warning items", async () => {
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-luna-cli-"));
      try {
        const home = NodePath.join(directory, "home"),
          schema = NodePath.join(directory, "schema.json"),
          instructions = NodePath.join(directory, "instructions.txt"),
          catalogPath = NodePath.join(directory, "catalog.json");
        await NodeFSP.mkdir(home);
        await Promise.all([
          NodeFSP.writeFile(
            schema,
            JSON.stringify({
              type: "object",
              additionalProperties: false,
              required: ["model"],
              properties: { model: { type: "string" } },
            }),
          ),
          NodeFSP.writeFile(instructions, "fixture"),
          NodeFSP.writeFile(catalogPath, JSON.stringify(catalog)),
        ]);
        const events = await new Promise<{ lines: unknown[]; stderr: string }>(
          (resolve, reject) => {
            const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
            delete env.OPENAI_API_KEY;
            delete env.CODEX_API_KEY;
            const child = NodeChildProcess.spawn(
              "codex",
              judgeArgs(schema, NodePath.join(directory, "out.json"), instructions, catalogPath),
              { cwd: directory, env },
            );
            const lines: unknown[] = [];
            let stdout = "",
              stderr = "",
              started = false;
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("timeout"));
            }, 20_000);
            child.stdout.on("data", (b: Buffer) => {
              stdout += b;
              const parts = stdout.split("\n");
              stdout = parts.pop() ?? "";
              for (const line of parts)
                if (line.trim() && !started) {
                  const v = JSON.parse(line) as { type?: string };
                  lines.push(v);
                  if (v.type === "turn.started") {
                    started = true;
                    child.kill("SIGKILL");
                  }
                }
            });
            child.stderr.on("data", (b: Buffer) => {
              stderr += b;
            });
            child.once("error", reject);
            child.once("close", () => {
              clearTimeout(timer);
              resolve({ lines, stderr });
            });
            child.stdin.end(JSON.stringify({ request: "fixture" }));
          },
        );
        expect(events.stderr).not.toMatch(
          /Error loading config|failed to parse model_catalog_json/,
        );
        expect(events.lines).toContainEqual(expect.objectContaining({ type: "turn.started" }));
        expect(
          events.lines.filter((e) => (e as { item?: { type?: string } }).item?.type === "error"),
        ).toEqual([]);
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    });
  },
);

describe("Luna broker bookkeeping", () => {
  it("ignores cancels outside the window and keeps room for new requests", async () => {
    const judge = vi.fn(async () => decision);
    const broker = new LunaDecisionBroker(judge, () => NOW);
    for (let index = 0; index < 5_000; index++) {
      broker.cancel(lunaId(`future-${index}`, NOW + 24 * 3_600_000));
    }
    await expect(broker.decide(lunaId("now"), input)).resolves.toEqual(decision);
  });

  it("records a cancel after old ids age out, so the cancelled id never runs", async () => {
    let now = NOW;
    const judge = vi.fn(async () => decision);
    const broker = new LunaDecisionBroker(judge, () => now);
    for (let index = 0; index < 4_096; index++) broker.cancel(lunaId(`old-${index}`, now));
    now += LUNA_REQUEST_TTL_MS + 1;
    const cancelled = lunaId("cancelled", now);
    broker.cancel(cancelled);
    await expect(broker.decide(cancelled, input)).rejects.toThrow("開始済み");
    expect(judge).not.toHaveBeenCalled();
  });

  it("never judges an id twice, and fails closed when flooded until old ids age out", async () => {
    let now = NOW;
    const judge = vi.fn(async () => decision);
    const broker = new LunaDecisionBroker(judge, () => now);
    const repeated = lunaId("repeated");
    await expect(broker.decide(repeated, input)).resolves.toEqual(decision);
    await expect(broker.decide(repeated, input)).rejects.toThrow("開始済み");
    for (let index = 0; index < 5_000; index++) broker.cancel(lunaId(`cancelled-${index}`));
    await expect(broker.decide(lunaId("during-flood"), input)).rejects.toThrow("混み合って");
    now += LUNA_REQUEST_TTL_MS + 1;
    await expect(broker.decide(lunaId("after", now), input)).resolves.toEqual(decision);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it("refuses an old or malformed id even after it was forgotten", async () => {
    let now = Date.UTC(2026, 9, 8);
    const judge = vi.fn(async () => decision);
    const broker = new LunaDecisionBroker(judge, () => now);
    const early = lunaId("early", now);
    broker.cancel(early);
    now += LUNA_REQUEST_TTL_MS + 1;
    for (let index = 0; index < 600; index++) broker.cancel(lunaId(`later-${index}`, now));
    await expect(broker.decide(early, input)).rejects.toThrow("期限切れ");
    await expect(broker.decide("not-a-luna-id-at-all-000000", input)).rejects.toThrow("期限切れ");
    await expect(broker.decide(lunaId("fresh", now), input)).resolves.toEqual(decision);
    expect(judge).toHaveBeenCalledTimes(1);
  });
});
