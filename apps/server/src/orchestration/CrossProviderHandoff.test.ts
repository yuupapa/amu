import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildHandoffPacket,
  computeHandoffBudget,
  DEFAULT_HANDOFF_BUDGET_CHARS,
  escapeHandoffText,
  type HandoffSource,
} from "./CrossProviderHandoff.ts";

const source = (overrides: Partial<HandoffSource> = {}): HandoffSource => ({
  env: {
    cwd: "/repo",
    branch: "main",
    worktreePath: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    fromDriver: "claudeAgent",
    fromModel: "claude-opus-5-5",
    fromTurnCount: 3,
  },
  firstUserMessage: { turn: 1, text: "ログイン画面を直して", contextLabels: [] },
  userMessages: [
    { turn: 2, text: "色は青で", contextLabels: [] },
    {
      turn: 3,
      text: "レビューだけにして、公開はしないで",
      contextLabels: ["選択したコード src/foo.ts:10-40"],
    },
  ],
  omittedUserMessages: 0,
  plan: { markdown: "1. 色を変える\n2. テスト", implemented: false },
  changes: [{ path: "src/foo.ts", additions: 12, deletions: 3, lastChangedTurn: 2 }],
  state: { lastTurn: "completed", errorSummary: null },
  log: [
    { kind: "assistant", turn: 1, model: "claude-opus-5-5", text: "ログイン画面を確認しました" },
    { kind: "tool", turn: 1, summary: "Edited src/foo.ts" },
    { kind: "assistant", turn: 2, model: "claude-opus-5-5", text: "青に変更しました" },
  ],
  omittedAssistantMessages: 0,
  omittedToolEntries: 0,
  ...overrides,
});

const minimal = (overrides: Partial<HandoffSource> = {}) =>
  source({ userMessages: [], plan: null, changes: [], log: [], ...overrides });

const built = (result: ReturnType<typeof buildHandoffPacket>) => {
  if (result._tag !== "built") throw new Error(`expected built, got ${result._tag}`);
  return result;
};

const NOW_SECTION_START = "\n\n[[AMU-NOW]]\n";
const beforeNow = (text: string) => text.slice(0, text.lastIndexOf(NOW_SECTION_START));

describe("computeHandoffBudget", () => {
  it("uses the configured budget when the current message is short", () => {
    expect(computeHandoffBudget("続けて", DEFAULT_HANDOFF_BUDGET_CHARS)).toBe(60_000);
  });

  it("shrinks to what the input limit leaves after the NOW section", () => {
    const now = "x".repeat(100_000);
    expect(computeHandoffBudget(now, DEFAULT_HANDOFF_BUDGET_CHARS)).toBe(
      120_000 - (NOW_SECTION_START.length + now.length) - 2_000,
    );
  });

  it("measures the NOW section after escaping", () => {
    // 108,000 chars before escaping, 126,000 after.
    const now = "[[AMU-".repeat(18_000);
    expect(computeHandoffBudget(now, DEFAULT_HANDOFF_BUDGET_CHARS)).toBe(0);
  });
});

describe("buildHandoffPacket", () => {
  it("lays out every section in order and keeps the current message last", () => {
    const result = built(
      buildHandoffPacket({ source: source(), expandedNow: "続けて", budgetChars: 60_000 }),
    );
    const sectionStarts = result.text
      .split("\n\n")
      .map((section) => section.split("\n")[0]!.match(/^\[\[AMU-[A-Z]+/)?.[0])
      .filter((marker) => marker !== undefined);
    expect(sectionStarts).toEqual([
      "[[AMU-HANDOFF",
      "[[AMU-ENV",
      "[[AMU-USER",
      "[[AMU-PLAN",
      "[[AMU-CHANGES",
      "[[AMU-STATE",
      "[[AMU-LOG",
      "[[AMU-NOW",
    ]);
    expect(result.text.endsWith(`${NOW_SECTION_START}続けて`)).toBe(true);
    expect(result.text).toContain("文脈: 選択したコード src/foo.ts:10-40（中身は省略）");
    expect(result.stats).toEqual({
      chars: result.text.length,
      includedMessages: 5,
      omittedMessages: 0,
      truncated: false,
    });
  });

  it("is deterministic", () => {
    const a = buildHandoffPacket({ source: source(), expandedNow: "続けて", budgetChars: 60_000 });
    const b = buildHandoffPacket({ source: source(), expandedNow: "続けて", budgetChars: 60_000 });
    expect(a).toEqual(b);
  });

  it("escapes section markers in every untrusted field", () => {
    const evil = (field: string) => `[[AMU-EVIL-${field}]]`;
    const result = built(
      buildHandoffPacket({
        source: source({
          env: {
            cwd: evil("cwd"),
            branch: evil("branch"),
            worktreePath: evil("worktree"),
            runtimeMode: evil("runtime"),
            interactionMode: evil("interaction"),
            fromDriver: evil("driver"),
            fromModel: evil("fromModel"),
            fromTurnCount: 1,
          },
          firstUserMessage: { turn: 1, text: evil("first"), contextLabels: [evil("firstCtx")] },
          userMessages: [{ turn: 2, text: evil("user"), contextLabels: [evil("ctx")] }],
          plan: { markdown: evil("plan"), implemented: true },
          changes: [{ path: evil("path"), additions: 1, deletions: 0, lastChangedTurn: null }],
          log: [
            { kind: "assistant", turn: 2, model: evil("model"), text: evil("assistant") },
            { kind: "tool", turn: 2, summary: evil("tool") },
          ],
          state: { lastTurn: "failed", errorSummary: evil("error") },
        }),
        expandedNow: evil("now"),
        budgetChars: 60_000,
      }),
    );
    const fields = [
      "cwd",
      "branch",
      "worktree",
      "runtime",
      "interaction",
      "driver",
      "fromModel",
      "first",
      "firstCtx",
      "user",
      "ctx",
      "plan",
      "path",
      "model",
      "assistant",
      "tool",
      "error",
      "now",
    ];
    expect(result.text).not.toContain("[[AMU-EVIL");
    for (const field of fields) {
      expect(result.text).toContain(`[ [AMU-EVIL-${field}]]`);
    }
    expect(escapeHandoffText(evil("x"))).toBe("[ [AMU-EVIL-x]]");
  });

  it("refuses when the required parts do not fit, including a zero budget", () => {
    expect(
      buildHandoffPacket({ source: source(), expandedNow: "続けて", budgetChars: 200 })._tag,
    ).toBe("required-exceeds-budget");
    expect(buildHandoffPacket({ source: source(), expandedNow: "x", budgetChars: 0 })._tag).toBe(
      "required-exceeds-budget",
    );
  });

  it("accepts a budget equal to the required parts and rejects one char less", () => {
    const exact = built(
      buildHandoffPacket({ source: minimal(), expandedNow: "続けて", budgetChars: 60_000 }),
    );
    const required = beforeNow(exact.text).length;
    // With only required parts and an empty change list, the full packet is the required part plus CHANGES.
    const requiredOnly = buildHandoffPacket({
      source: minimal({ changes: null }),
      expandedNow: "続けて",
      budgetChars: 0,
    });
    if (requiredOnly._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    expect(
      buildHandoffPacket({
        source: minimal({ changes: null }),
        expandedNow: "続けて",
        budgetChars: requiredOnly.requiredChars,
      })._tag,
    ).toBe("built");
    expect(
      buildHandoffPacket({
        source: minimal({ changes: null }),
        expandedNow: "続けて",
        budgetChars: requiredOnly.requiredChars - 1,
      })._tag,
    ).toBe("required-exceeds-budget");
    expect(required).toBeGreaterThan(requiredOnly.requiredChars);
  });

  it("never exceeds the input limit, even when escaping grows the current message", () => {
    const now = "[[AMU-".repeat(18_000);
    const result = buildHandoffPacket({
      source: minimal(),
      expandedNow: now,
      budgetChars: computeHandoffBudget(now, DEFAULT_HANDOFF_BUDGET_CHARS),
    });
    expect(result._tag).toBe("required-exceeds-budget");
  });

  it("accepts a final input of 119,999 and 120,000 chars and rejects 120,001", () => {
    const refused = buildHandoffPacket({ source: minimal(), expandedNow: "", budgetChars: 0 });
    if (refused._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    const nowFor = (target: number) =>
      "a".repeat(target - refused.requiredChars - NOW_SECTION_START.length);
    for (const target of [119_999, 120_000]) {
      const result = built(
        buildHandoffPacket({ source: minimal(), expandedNow: nowFor(target), budgetChars: 60_000 }),
      );
      expect(result.text.length).toBe(target);
    }
    expect(
      buildHandoffPacket({ source: minimal(), expandedNow: nowFor(120_001), budgetChars: 60_000 })
        ._tag,
    ).toBe("required-exceeds-budget");
    expect(PROVIDER_SEND_TURN_MAX_INPUT_CHARS).toBe(120_000);
  });

  it("keeps the packet before the current message within every budget", () => {
    const userMessages = Array.from({ length: 60 }, (_, i) => ({
      turn: i + 2,
      text: "い".repeat(300),
      contextLabels: [],
    }));
    const log = Array.from({ length: 80 }, (_, i) =>
      i % 2 === 0
        ? { kind: "assistant" as const, turn: i, model: "m", text: "う".repeat(700) }
        : { kind: "tool" as const, turn: i, summary: "え".repeat(120) },
    );
    const changes = Array.from({ length: 30 }, (_, i) => ({
      path: `src/file${i}.ts`,
      additions: i,
      deletions: 0,
      lastChangedTurn: i,
    }));
    const full = source({ userMessages, log, changes });
    for (const budgetChars of [1_500, 2_000, 4_000, 9_000, 20_000, 60_000]) {
      const result = buildHandoffPacket({ source: full, expandedNow: "続けて", budgetChars });
      if (result._tag === "built") {
        expect(beforeNow(result.text).length).toBeLessThanOrEqual(budgetChars);
      }
    }
  });

  it("keeps optional user messages newest first and contiguous, with the first and latest three", () => {
    const userMessages = Array.from({ length: 40 }, (_, i) => ({
      turn: i + 2,
      text: `指示${i + 2} ${"あ".repeat(400)}`,
      contextLabels: [],
    }));
    const tight = built(
      buildHandoffPacket({
        source: minimal({ userMessages }),
        expandedNow: "続けて",
        budgetChars: 6_000,
      }),
    );
    expect(tight.text).toContain("ログイン画面を直して");
    for (const turn of [39, 40, 41]) expect(tight.text).toContain(`指示${turn} `);
    expect(tight.text).not.toContain("指示2 ");
    expect(tight.text).toMatch(/省略した発言: [1-9]\d* 件/);
    expect(tight.stats.truncated).toBe(true);
    const kept = [...tight.text.matchAll(/指示(\d+) /g)].map((m) => Number(m[1]));
    expect(kept).toEqual(Array.from({ length: kept.length }, (_, i) => 41 - kept.length + 1 + i));
  });

  it("fills sections in priority order: optional users, plan, changes, assistant, tools", () => {
    const prioritized = source({
      userMessages: [
        { turn: 2, text: `OPTU-OLD ${"a".repeat(200)}`, contextLabels: [] },
        { turn: 3, text: `OPTU-NEW ${"a".repeat(200)}`, contextLabels: [] },
        { turn: 4, text: "REQ-1", contextLabels: [] },
        { turn: 5, text: "REQ-2", contextLabels: [] },
        { turn: 6, text: "REQ-3", contextLabels: [] },
      ],
      plan: { markdown: `PLANMARK ${"p".repeat(200)}`, implemented: false },
      changes: [
        { path: `old-${"o".repeat(200)}.ts`, additions: 1, deletions: 0, lastChangedTurn: 1 },
        { path: "new.ts", additions: 1, deletions: 0, lastChangedTurn: 5 },
      ],
      log: [
        { kind: "assistant", turn: 1, model: "m", text: `ASSIST-OLD ${"b".repeat(200)}` },
        { kind: "tool", turn: 1, summary: `TOOL-OLD ${"c".repeat(200)}` },
        { kind: "assistant", turn: 5, model: "m", text: `ASSIST-NEW ${"b".repeat(200)}` },
        { kind: "tool", turn: 5, summary: `TOOL-NEW ${"c".repeat(200)}` },
      ],
    });
    // Within one section, an older item never survives while a newer one is dropped.
    const pairs = [
      ["OPTU-NEW", "OPTU-OLD"],
      ["new.ts", "old-"],
      ["ASSIST-NEW", "ASSIST-OLD"],
      ["TOOL-NEW", "TOOL-OLD"],
    ] as const;
    const full = built(
      buildHandoffPacket({ source: prioritized, expandedNow: "続けて", budgetChars: 60_000 }),
    );
    const fullLength = beforeNow(full.text).length;
    let checkedBudgets = 0;
    for (let budget = fullLength; budget >= 0; budget -= 7) {
      const result = buildHandoffPacket({
        source: prioritized,
        expandedNow: "続けて",
        budgetChars: budget,
      });
      if (result._tag !== "built") break;
      for (const [newer, older] of pairs) {
        if (result.text.includes(older)) expect(result.text).toContain(newer);
      }
      if (result.text.includes("TOOL-NEW")) expect(result.text).toContain("OPTU-NEW");
      if (result.text.includes("ASSIST-NEW")) expect(result.text).toContain("OPTU-NEW");
      expect(beforeNow(result.text).length).toBeLessThanOrEqual(budget);
      checkedBudgets += 1;
    }
    expect(checkedBudgets).toBeGreaterThan(10);
  });

  it("drops the oldest changed files first and keeps the newest when only it fits", () => {
    const changes = Array.from({ length: 201 }, (_, i) => ({
      path: `f${i + 1}.ts`,
      additions: 1,
      deletions: 0,
      lastChangedTurn: i + 1,
    }));
    const many = built(
      buildHandoffPacket({
        source: minimal({ changes }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(many.text).toContain("f201.ts");
    expect(many.text).not.toContain("- f1.ts ");
    expect(many.text).toContain("省略した古いファイル: 1 件");

    const twoFiles = minimal({
      changes: [
        { path: `${"o".repeat(200)}.ts`, additions: 1, deletions: 0, lastChangedTurn: 1 },
        { path: "new.ts", additions: 1, deletions: 0, lastChangedTurn: 2 },
      ],
    });
    const fullLength = beforeNow(
      built(buildHandoffPacket({ source: twoFiles, expandedNow: "続けて", budgetChars: 60_000 }))
        .text,
    ).length;
    const tight = built(
      buildHandoffPacket({
        source: twoFiles,
        expandedNow: "続けて",
        budgetChars: fullLength - 150,
      }),
    );
    expect(tight.text).toContain("new.ts");
    expect(tight.text).not.toContain("o".repeat(200));
  });

  it("counts assistant messages omitted by the source query", () => {
    const result = built(
      buildHandoffPacket({
        source: minimal({ omittedAssistantMessages: 10, omittedToolEntries: 4 }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.stats.omittedMessages).toBe(10);
    expect(result.stats.truncated).toBe(true);
  });

  it("clips a single message at 6,000 chars", () => {
    const result = built(
      buildHandoffPacket({
        source: source({
          userMessages: [{ turn: 2, text: "長".repeat(7_000), contextLabels: [] }],
        }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("…（1000字省略）");
    expect(result.stats.truncated).toBe(true);
  });

  it("marks a clipped error summary as truncated", () => {
    const result = built(
      buildHandoffPacket({
        source: minimal({ state: { lastTurn: "failed", errorSummary: "x".repeat(7_000) } }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("最後のターンは失敗しました。");
    expect(result.stats.truncated).toBe(true);
  });

  it("says when changes are unavailable", () => {
    const result = built(
      buildHandoffPacket({
        source: source({ changes: null }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("変更内容を取得できませんでした。");
  });

  it("reports interrupted turns and the last error", () => {
    const result = built(
      buildHandoffPacket({
        source: source({ state: { lastTurn: "interrupted", errorSummary: "Tool timed out" } }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("最後のターンは中断されました。");
    expect(result.text).toContain("最後のエラー: Tool timed out");
  });
  it("includes an optional user message exactly at the budget where it fits", () => {
    const fourShort = minimal({
      changes: null,
      userMessages: [2, 3, 4, 5].map((turn) => ({ turn, text: `OK${turn}`, contextLabels: [] })),
    });
    const refused = buildHandoffPacket({
      source: fourShort,
      expandedNow: "続けて",
      budgetChars: 0,
    });
    if (refused._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    // Required parts omit OK2; including it adds its line and keeps the omission line's width.
    const withUser = refused.requiredChars + "(ターン2) OK2".length + 1;
    const exact = built(
      buildHandoffPacket({ source: fourShort, expandedNow: "続けて", budgetChars: withUser }),
    );
    expect(beforeNow(exact.text).length).toBe(withUser);
    expect(exact.text).toContain("(ターン2) OK2");
    expect(exact.text).toContain("省略した発言: 0 件");
    expect(exact.text).not.toContain("[[AMU-CHANGES]]");
    const below = built(
      buildHandoffPacket({ source: fourShort, expandedNow: "続けて", budgetChars: withUser - 1 }),
    );
    expect(below.text).not.toContain("(ターン2) OK2");
    expect(below.text).toContain("省略した発言: 1 件");
  });

  it("gives optional user messages priority over the plan", () => {
    const optional = { turn: 2, text: `OPTIONAL ${"o".repeat(100)}`, contextLabels: [] };
    const req = [3, 4, 5].map((turn) => ({ turn, text: "REQ", contextLabels: [] }));
    const plan = { markdown: "PLAN", implemented: false };
    const both = minimal({ changes: null, userMessages: [optional, ...req], plan });
    const refused = buildHandoffPacket({ source: both, expandedNow: "続けて", budgetChars: 0 });
    if (refused._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    const userIncrement = `(ターン2) ${optional.text}`.length + 1;
    const planIncrement = "[[AMU-PLAN]]\nPLAN".length + 2;
    expect(planIncrement).toBeLessThanOrEqual(userIncrement);
    const result = built(
      buildHandoffPacket({
        source: both,
        expandedNow: "続けて",
        budgetChars: refused.requiredChars + userIncrement,
      }),
    );
    expect(result.text).toContain("OPTIONAL");
    expect(result.text).not.toContain("[[AMU-PLAN]]");
  });

  it("gives changes priority over assistant text", () => {
    const changeOnly = minimal({
      changes: [{ path: "CHANGE.ts", additions: 1, deletions: 0, lastChangedTurn: 1 }],
    });
    const changeLength = beforeNow(
      built(buildHandoffPacket({ source: changeOnly, expandedNow: "続けて", budgetChars: 60_000 }))
        .text,
    ).length;
    const both = minimal({
      changes: changeOnly.changes,
      log: [{ kind: "assistant", turn: 1, model: "m", text: "ASSIST" }],
    });
    const assistOnlyIncrement =
      beforeNow(
        built(
          buildHandoffPacket({
            source: minimal({ changes: null, log: both.log }),
            expandedNow: "続けて",
            budgetChars: 60_000,
          }),
        ).text,
      ).length -
      beforeNow(
        built(
          buildHandoffPacket({
            source: minimal({ changes: null }),
            expandedNow: "続けて",
            budgetChars: 60_000,
          }),
        ).text,
      ).length;
    const refused = buildHandoffPacket({ source: both, expandedNow: "続けて", budgetChars: 0 });
    if (refused._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    expect(assistOnlyIncrement).toBeLessThanOrEqual(changeLength - refused.requiredChars);
    const result = built(
      buildHandoffPacket({ source: both, expandedNow: "続けて", budgetChars: changeLength }),
    );
    expect(result.text).toContain("CHANGE.ts");
    expect(result.text).not.toContain("ASSIST");
  });

  it("says the last turn state is unknown when it is not recorded", () => {
    const result = built(
      buildHandoffPacket({
        source: minimal({ state: { lastTurn: null, errorSummary: null } }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("最後のターンの状態は分かりません。");
    expect(result.text).not.toContain("最後のターンは完了しています。");
  });

  it("counts omissions from the source query and the budget in each omission line", () => {
    const result = built(
      buildHandoffPacket({
        source: minimal({
          changes: null,
          omittedUserMessages: 9,
          omittedAssistantMessages: 99,
          omittedToolEntries: 1,
          log: [{ kind: "assistant", turn: 1, model: "m", text: "kept" }],
        }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    expect(result.text).toContain("省略した発言: 9 件");
    expect(result.text).toContain("省略した記録: 100 件");
  });

  it("keeps a single changed file exactly at the budget where it fits", () => {
    const oneFile = minimal({
      changes: [{ path: "a", additions: 0, deletions: 0, lastChangedTurn: null }],
    });
    const full = built(
      buildHandoffPacket({ source: oneFile, expandedNow: "続けて", budgetChars: 60_000 }),
    );
    const exact = built(
      buildHandoffPacket({
        source: oneFile,
        expandedNow: "続けて",
        budgetChars: beforeNow(full.text).length,
      }),
    );
    expect(exact.text).toContain("- a (+0 −0)");
    expect(exact.text).toContain("省略した古いファイル: 0 件");
  });

  it("gives the plan priority over changes, and assistant text over tool summaries", () => {
    const planVsChanges = minimal({
      plan: { markdown: `PLANMARK ${"p".repeat(300)}`, implemented: false },
      changes: [{ path: `${"c".repeat(300)}.ts`, additions: 1, deletions: 0, lastChangedTurn: 1 }],
    });
    const required = buildHandoffPacket({
      source: planVsChanges,
      expandedNow: "続けて",
      budgetChars: 0,
    });
    if (required._tag !== "required-exceeds-budget") throw new Error("expected refusal");
    const planOnly = built(
      buildHandoffPacket({
        source: minimal({ plan: planVsChanges.plan, changes: null }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    // Room for the plan but not for the plan and the changes section together.
    const budget =
      beforeNow(planOnly.text).length -
      "[[AMU-CHANGES]]\n変更内容を取得できませんでした。".length -
      2 +
      50;
    const result = built(
      buildHandoffPacket({ source: planVsChanges, expandedNow: "続けて", budgetChars: budget }),
    );
    expect(result.text).toContain("PLANMARK");
    expect(result.text).not.toContain("[[AMU-CHANGES]]");

    const assistantVsTool = minimal({
      changes: null,
      log: [
        { kind: "assistant", turn: 1, model: "m", text: `ASSIST ${"a".repeat(300)}` },
        { kind: "tool", turn: 1, summary: `TOOL ${"t".repeat(300)}` },
      ],
    });
    const assistantOnly = built(
      buildHandoffPacket({
        source: minimal({ changes: null, log: [assistantVsTool.log[0]!] }),
        expandedNow: "続けて",
        budgetChars: 60_000,
      }),
    );
    const logResult = built(
      buildHandoffPacket({
        source: assistantVsTool,
        expandedNow: "続けて",
        budgetChars: beforeNow(assistantOnly.text).length + 100,
      }),
    );
    expect(logResult.text).toContain("ASSIST");
    expect(logResult.text).not.toContain("TOOL ");
  });

  it("falls back to a smaller lower-priority section when a larger higher one does not fit", () => {
    const bigPlan = minimal({
      changes: null,
      plan: { markdown: `PLANMARK ${"p".repeat(3_000)}`, implemented: false },
      log: [{ kind: "assistant", turn: 1, model: "m", text: "ASSIST short" }],
    });
    const result = built(
      buildHandoffPacket({ source: bigPlan, expandedNow: "続けて", budgetChars: 1_500 }),
    );
    expect(result.text).not.toContain("PLANMARK");
    expect(result.text).toContain("ASSIST short");
  });

  it("accounts for every user and assistant message as included or omitted", () => {
    const users = Array.from({ length: 30 }, (_, i) => ({
      turn: i + 2,
      text: "u".repeat(200),
      contextLabels: [],
    }));
    const log = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? { kind: "assistant" as const, turn: i, model: "m", text: "a".repeat(250) }
        : { kind: "tool" as const, turn: i, summary: "t".repeat(80) },
    );
    const mixed = source({
      userMessages: users,
      log,
      omittedUserMessages: 7,
      omittedAssistantMessages: 5,
      omittedToolEntries: 9,
    });
    const totalMessages = 1 + users.length + 7 + 20 + 5;
    for (const budgetChars of [2_500, 5_000, 10_000, 60_000]) {
      const result = built(
        buildHandoffPacket({ source: mixed, expandedNow: "続けて", budgetChars }),
      );
      expect(result.stats.includedMessages + result.stats.omittedMessages).toBe(totalMessages);
      expect(result.text).toContain(
        `省略した発言: ${7 + users.length - 3 - (result.text.match(/\(ターン\d+\) u{200}/g)!.length - 3)} 件`,
      );
    }
  });
});
