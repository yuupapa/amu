// @effect-diagnostics nodeBuiltinImport:off - read once per decision, before the judge process starts.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LUNA_JUDGE_ORDER, type AutoChoice, type LunaJudgeKind } from "@t3tools/shared/lunaAuto";

/**
 * 結パパ's policy for which model Auto should pick (2026-10-08). Luna gets the
 * table as guidance, and models outside it are not offered at all. A
 * `luna-routing.json` in the server's state folder replaces the defaults:
 *
 *   { "preferred": ["claude-opus-5-5", …], "fallback": ["grok-4.7"], "guidance": "…",
 *     "judges": ["claude", "codex", "cursor"], "autoFolder": true }
 */
export type LunaRoutingPolicy = {
  /** Models Luna chooses from. */
  readonly preferred: ReadonlyArray<string>;
  /** Offered only when none of `preferred` is available (another person's setup). */
  readonly fallback: ReadonlyArray<string>;
  /** Appended to Luna's instructions. */
  readonly guidance: string;
  /** Which AIs judge, first one first (see LUNA_JUDGE_ORDER). */
  readonly judges: ReadonlyArray<LunaJudgeKind>;
  /** Whether Auto also picks the work folder from earlier work (luna/WorkFolders.ts). */
  readonly autoFolder: boolean;
};

export const DEFAULT_LUNA_ROUTING_POLICY: LunaRoutingPolicy = {
  preferred: [
    "gpt-6-luna",
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "gpt-6.1-sol",
    "gemini-3.8-flash",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
  ],
  fallback: ["grok-4.7"],
  guidance: [
    "依頼の種類ごとの選び方（上が第一候補、矢印の先が次点。第一候補が一覧に無いときだけ次点を選ぶ）:",
    "- 軽い質問・要約・ちょっとした手直し: gpt-6-luna → claude-sonnet-5-5",
    "- 文章（台本・記事・投稿など、人が読む文章を書く）: claude-sonnet-5-5 → gemini-3.8-flash",
    "- 箇条書き・資料の整理: claude-sonnet-5-5 → claude-opus-5-5",
    "- ふつうのコード修正: gpt-6.1-sol（思考は中くらい） → claude-sonnet-5-5",
    "- コードのレビュー・事実確認・調べもの: gpt-6.1-sol → claude-opus-5-5",
    "- 複雑な設計・原因の調査・高い正確さが要る仕事: claude-opus-5-5 → gpt-6.1-sol",
    "- 上のどれも一覧に無いときだけ grok-4.7 を選ぶ。",
  ].join("\n"),
  judges: LUNA_JUDGE_ORDER,
  autoFolder: true,
};

function readPolicyFile(stateDir: string): LunaRoutingPolicy | null {
  const file = NodePath.join(stateDir, "luna-routing.json");
  if (!NodeFS.existsSync(file)) return null;
  const value: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const list = (field: unknown) =>
    Array.isArray(field) && field.every((item) => typeof item === "string")
      ? (field as string[])
      : null;
  const preferred = list(record.preferred);
  const fallback = list(record.fallback) ?? [];
  const guidance = typeof record.guidance === "string" ? record.guidance : "";
  if (preferred === null || preferred.length === 0) return null;
  const judges = (list(record.judges) ?? []).filter((kind): kind is LunaJudgeKind =>
    (LUNA_JUDGE_ORDER as ReadonlyArray<string>).includes(kind),
  );
  return {
    preferred,
    fallback,
    guidance,
    judges: judges.length > 0 ? [...new Set(judges)] : LUNA_JUDGE_ORDER,
    autoFolder: record.autoFolder !== false,
  };
}

export function loadLunaRoutingPolicy(stateDir: string): LunaRoutingPolicy {
  try {
    return readPolicyFile(stateDir) ?? DEFAULT_LUNA_ROUTING_POLICY;
  } catch {
    // A broken file must not stop Auto; the defaults still apply.
    return DEFAULT_LUNA_ROUTING_POLICY;
  }
}

/**
 * The choices Luna may pick from under the policy. With none of the preferred
 * models available, the fallback ones are offered; with none of those either,
 * every available choice is, so Auto still works on another person's setup.
 */
export function applyLunaRoutingPolicy(
  choices: ReadonlyArray<AutoChoice>,
  policy: LunaRoutingPolicy,
): AutoChoice[] {
  const preferred = choices.filter((choice) => policy.preferred.includes(choice.model));
  if (preferred.length > 0) return preferred;
  const fallback = choices.filter((choice) => policy.fallback.includes(choice.model));
  if (fallback.length > 0) return fallback;
  return [...choices];
}
