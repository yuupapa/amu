// @effect-diagnostics nodeBuiltinImport:off - offline executable fixtures use temporary files only.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ServerProvider, ProviderInstanceConfigMap } from "@t3tools/contracts";
import type { AutoChoice } from "@t3tools/shared/lunaAuto";
import * as Schema from "effect/Schema";
import {
  acceptClaudeJudgeEvent,
  acceptCursorJudgeEvent,
  claudeJudgeArgs,
  cursorJudgeArgs,
  findCursorAgent,
  LunaDecisionBroker,
  parseJudgeText,
  runClaudeJudge,
  runCursorJudge,
  type JudgeTarget,
} from "./LunaDecision.ts";
import { resolveClaudeJudge, resolveCursorJudge } from "./LunaPreflight.ts";
import { DEFAULT_LUNA_ROUTING_POLICY, loadLunaRoutingPolicy } from "./LunaRoutingPolicy.ts";

const choices: AutoChoice[] = [
  {
    model: "claude-sonnet-5-5",
    name: "Sonnet 5.5",
    driver: "claudeAgent",
    instanceId: "claudeAgent",
    effortId: "effort",
    efforts: ["low", "medium"],
  },
];
const decision = { model: "claude-sonnet-5-5", effort: "low", reason: "短い文章の手直しのため" };
const runtime = { binary: "/fixture-only", home: "", environment: {} };
const haiku: JudgeTarget = { kind: "claude", name: "Haiku", runtime };
const luna: JudgeTarget = { kind: "codex", name: "Luna", runtime };
const composer: JudgeTarget = { kind: "cursor", name: "Composer", runtime };
const input = (judges: JudgeTarget[]) => ({ prompt: "架空の依頼", choices, judges });

describe("Auto judges in order", () => {
  it("lets the next judge pick when the first one fails", async () => {
    const judge = vi.fn(async (target: JudgeTarget) => {
      if (target.kind === "claude") throw new Error("Haikuを利用できません（CLI 終了コード 1）。");
      return decision;
    });
    const broker = new LunaDecisionBroker(judge, () => 1_000);
    const verdict = await broker.decide(broker.issue(), input([haiku, luna, composer]));
    expect(verdict).toEqual({ decision, judge: "Luna" });
    expect(judge.mock.calls.map(([target]) => target.kind)).toEqual(["claude", "codex"]);
  });

  it("hands over when a judge picks a model that is not offered", async () => {
    const judge = vi.fn(async (target: JudgeTarget) =>
      target.kind === "claude" ? { ...decision, model: "not-offered" } : decision,
    );
    const broker = new LunaDecisionBroker(judge, () => 1_000);
    expect(await broker.decide(broker.issue(), input([haiku, composer]))).toEqual({
      decision,
      judge: "Composer",
    });
  });

  it("reports every failure once when no judge can pick", async () => {
    const judge = vi.fn(async (target: JudgeTarget) => {
      throw new Error(`${target.name}を利用できません。元の依頼を残して手動送信に戻ります。`);
    });
    const broker = new LunaDecisionBroker(judge, () => 1_000);
    const result = broker.decide(broker.issue(), input([haiku, luna]));
    await expect(result).rejects.toThrow(
      "Haikuを利用できません。 Lunaを利用できません。 元の依頼を残して手動送信に戻ります。",
    );
  });

  it("stops at a cancel and does not ask the next judge", async () => {
    let broker!: LunaDecisionBroker;
    let id = "";
    const judge = vi.fn(async (target: JudgeTarget) => {
      if (target.kind === "claude") {
        broker.cancel(id);
        throw new Error("モデル選択を取り消しました。");
      }
      return decision;
    });
    broker = new LunaDecisionBroker(judge, () => 1_000);
    id = broker.issue();
    await expect(broker.decide(id, input([haiku, luna]))).rejects.toThrow("取り消");
    expect(judge).toHaveBeenCalledOnce();
  });

  it("refuses to start without any judge", async () => {
    const broker = new LunaDecisionBroker(
      vi.fn(async () => decision),
      () => 1_000,
    );
    await expect(broker.decide(broker.issue(), input([]))).rejects.toThrow("使えるAI");
  });
});

describe("Haiku judge", () => {
  it("runs with no tools, no settings and no session", () => {
    const args = claudeJudgeArgs("{}", "指示");
    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args).toContain("--no-session-persistence");
  });

  it("stops on an API key login, extra tools or an MCP server", () => {
    const init = { type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] };
    expect(acceptClaudeJudgeEvent({ ...init, apiKeySource: "none" })).toBeUndefined();
    expect(() => acceptClaudeJudgeEvent({ ...init, apiKeySource: "ANTHROPIC_API_KEY" })).toThrow(
      "APIキー",
    );
    expect(() =>
      acceptClaudeJudgeEvent({
        ...init,
        apiKeySource: "none",
        tools: ["StructuredOutput", "Bash"],
      }),
    ).toThrow("道具");
    expect(() =>
      acceptClaudeJudgeEvent({ ...init, apiKeySource: "none", mcp_servers: [{ name: "x" }] }),
    ).toThrow("道具");
  });

  it("allows only the StructuredOutput tool call", () => {
    const say = (content: unknown[]) => ({ type: "assistant", message: { content } });
    expect(
      acceptClaudeJudgeEvent(
        say([{ type: "thinking" }, { type: "tool_use", name: "StructuredOutput" }]),
      ),
    ).toBeUndefined();
    expect(() => acceptClaudeJudgeEvent(say([{ type: "tool_use", name: "Bash" }]))).toThrow(
      "判断以外",
    );
    expect(() => acceptClaudeJudgeEvent(say([{ type: "server_tool_use" }]))).toThrow("判断以外");
  });

  it("takes the structured answer from a successful result only", () => {
    expect(
      acceptClaudeJudgeEvent({ type: "result", subtype: "success", structured_output: decision }),
    ).toEqual(decision);
    expect(() =>
      acceptClaudeJudgeEvent({ type: "result", subtype: "error_max_turns", is_error: true }),
    ).toThrow("利用できません");
  });

  it("runs the real transport against an offline CLI and strips API credentials", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-haiku-fixture-"));
    const binary = NodePath.join(directory, "claude"),
      receipt = NodePath.join(directory, "receipt.json");
    const events = [
      {
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        tools: ["StructuredOutput"],
        mcp_servers: [],
      },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "StructuredOutput" }] } },
      { type: "result", subtype: "success", is_error: false, structured_output: decision },
    ];
    try {
      await NodeFSP.writeFile(
        binary,
        `#!/usr/bin/env node\nconst fs=require('node:fs');let stdin='';process.stdin.on('data',b=>stdin+=b);process.stdin.on('end',()=>{fs.writeFileSync(process.env.FIXTURE_RECEIPT,JSON.stringify({args:process.argv.slice(2),stdin:JSON.parse(stdin),apiKey:!!process.env.ANTHROPIC_API_KEY,token:!!process.env.ANTHROPIC_AUTH_TOKEN,home:process.env.CLAUDE_CONFIG_DIR,cwd:process.cwd()}));for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));});\n`,
        { mode: 0o755 },
      );
      const result = await runClaudeJudge({
        prompt: "架空の依頼",
        choices,
        signal: new AbortController().signal,
        runtime: {
          binary,
          home: "/fixture-claude-home",
          environment: {
            PATH: process.env.PATH,
            FIXTURE_RECEIPT: receipt,
            ANTHROPIC_API_KEY: "fixture-must-not-forward",
            ANTHROPIC_AUTH_TOKEN: "fixture-must-not-forward",
          },
        },
      });
      expect(result).toEqual(decision);
      const seen = JSON.parse(await NodeFSP.readFile(receipt, "utf8"));
      expect(seen.apiKey).toBe(false);
      expect(seen.token).toBe(false);
      expect(seen.home).toBe("/fixture-claude-home");
      expect(seen.stdin.request).toBe("架空の依頼");
      expect(seen.cwd).not.toBe(process.cwd());
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Composer judge", () => {
  it("runs read-only in a sandbox in the given empty folder", () => {
    const args = cursorJudgeArgs("/tmp/empty-judge", "依頼");
    expect(args[args.indexOf("--mode") + 1]).toBe("ask");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("enabled");
    expect(args[args.indexOf("--workspace") + 1]).toBe("/tmp/empty-judge");
    expect(args[args.indexOf("--model") + 1]).toBe("composer-2.5");
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--approve-mcps");
  });

  it("stops at any tool call and any non-text answer", () => {
    expect(() => acceptCursorJudgeEvent({ type: "tool_call", subtype: "started" })).toThrow(
      "判断以外",
    );
    expect(() =>
      acceptCursorJudgeEvent({ type: "assistant", message: { content: [{ type: "tool_use" }] } }),
    ).toThrow("判断以外");
    expect(acceptCursorJudgeEvent({ type: "thinking", subtype: "delta" })).toBeUndefined();
  });

  it("reads the JSON answer, also inside a code fence", () => {
    expect(parseJudgeText(JSON.stringify(decision))).toEqual(decision);
    expect(parseJudgeText("```json\n" + JSON.stringify(decision) + "\n```")).toEqual(decision);
    expect(() => parseJudgeText("Sonnetがよいと思います")).toThrow("読み取れません");
    expect(
      acceptCursorJudgeEvent({
        type: "result",
        subtype: "success",
        result: JSON.stringify(decision),
      }),
    ).toEqual(decision);
  });

  it("runs the real transport against an offline CLI and stops at a tool call", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "amu-composer-fixture-"),
    );
    const binary = NodePath.join(directory, "cursor-agent"),
      receipt = NodePath.join(directory, "receipt.json");
    const script = (events: unknown[]) =>
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(process.env.FIXTURE_RECEIPT,JSON.stringify({args:process.argv.slice(2),apiKey:!!process.env.CURSOR_API_KEY,cwd:process.cwd()}));for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e));\n`;
    const call = () =>
      runCursorJudge({
        prompt: "架空の依頼",
        choices,
        signal: new AbortController().signal,
        runtime: {
          binary,
          home: "",
          environment: {
            PATH: process.env.PATH,
            FIXTURE_RECEIPT: receipt,
            CURSOR_API_KEY: "fixture-must-not-forward",
          },
        },
      });
    try {
      await NodeFSP.writeFile(
        binary,
        script([
          { type: "system", subtype: "init" },
          { type: "assistant", message: { content: [{ type: "text", text: "…" }] } },
          { type: "result", subtype: "success", is_error: false, result: JSON.stringify(decision) },
        ]),
        { mode: 0o755 },
      );
      expect(await call()).toEqual(decision);
      const seen = JSON.parse(await NodeFSP.readFile(receipt, "utf8"));
      expect(seen.apiKey).toBe(false);
      // The judge ran in its own empty folder, removed again after the run.
      const workspace = seen.args[seen.args.indexOf("--workspace") + 1];
      expect(NodePath.basename(workspace)).toMatch(/^amu-composer-judge-/);
      expect(NodePath.basename(seen.cwd)).toBe(NodePath.basename(workspace));

      await NodeFSP.writeFile(
        binary,
        script([
          { type: "system", subtype: "init" },
          { type: "tool_call", subtype: "started" },
          { type: "result", subtype: "success", is_error: false, result: JSON.stringify(decision) },
        ]),
        { mode: 0o755 },
      );
      await expect(call()).rejects.toThrow("判断以外");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("finds cursor-agent on PATH when the configured path does not run", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-cursor-path-"));
    try {
      const bin = NodePath.join(directory, "bin");
      await NodeFSP.mkdir(bin);
      await NodeFSP.writeFile(NodePath.join(bin, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
      const environment = { PATH: bin, HOME: directory };
      expect(findCursorAgent(NodePath.join(directory, "missing"), environment)).toBe(
        NodePath.join(bin, "cursor-agent"),
      );
      expect(findCursorAgent(undefined, { PATH: "", HOME: directory })).toBeNull();
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeConfigs = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const snapshot = (driver: string, auth: Record<string, unknown>) =>
  decodeProvider({
    instanceId: driver,
    driver,
    enabled: true,
    installed: true,
    version: "offline-fixture",
    status: "ready",
    auth: { status: "authenticated", ...auth },
    checkedAt: "2026-10-08T00:00:00Z",
    models: [],
  });

describe("which connected AIs may judge", () => {
  const configs = decodeConfigs({
    claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/offline-claude" } },
    cursor: { driver: "cursor", config: {} },
  });

  it("uses a Claude subscription and skips API keys and Bedrock", () => {
    expect(resolveClaudeJudge([snapshot("claudeAgent", { type: "max" })], configs)).toMatchObject({
      ok: true,
      config: { binaryPath: "/offline-claude" },
    });
    for (const type of ["apiKey", "bedrock", undefined])
      expect(resolveClaudeJudge([snapshot("claudeAgent", type ? { type } : {})], configs)).toEqual({
        ok: false,
        skip: "not_subscription",
      });
    expect(resolveClaudeJudge([], configs)).toEqual({ ok: false, skip: "missing" });
  });

  it("uses the Cursor account login and skips API keys and custom endpoints", () => {
    expect(resolveCursorJudge([snapshot("cursor", { type: "browser" })], configs).ok).toBe(true);
    expect(resolveCursorJudge([snapshot("cursor", { type: "api-key" })], configs)).toEqual({
      ok: false,
      skip: "not_subscription",
    });
    const custom = decodeConfigs({
      cursor: { driver: "cursor", config: { apiEndpoint: "https://example.invalid" } },
    });
    expect(resolveCursorJudge([snapshot("cursor", { type: "browser" })], custom)).toEqual({
      ok: false,
      skip: "custom_endpoint",
    });
  });
});

describe("judge order in luna-routing.json", () => {
  it("defaults to Haiku, Luna, Composer", () => {
    expect(DEFAULT_LUNA_ROUTING_POLICY.judges).toEqual(["claude", "codex", "cursor"]);
  });

  it("reads a custom order and drops unknown names", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-luna-policy-"));
    try {
      await NodeFSP.writeFile(
        NodePath.join(directory, "luna-routing.json"),
        JSON.stringify({
          preferred: ["gpt-6-luna"],
          judges: ["codex", "gemini", "codex", "claude"],
        }),
      );
      expect(loadLunaRoutingPolicy(directory).judges).toEqual(["codex", "claude"]);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
