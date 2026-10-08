import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ServerProvider,
} from "@t3tools/contracts";
import { LUNA_JUDGE_MODEL, type AutoChoice } from "@t3tools/shared/lunaAuto";
import * as Schema from "effect/Schema";

const decodeLunaPreflightConfig = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeConfig = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCursorConfig = Schema.decodeUnknownSync(CursorSettings);
export const lunaPreflightMessages = {
  codex_missing: "Codex接続が見つかりません。Amuのプロバイダー設定で接続を確認してください。",
  codex_disabled: "Codex接続が無効です。Amuのプロバイダー設定で有効状態を確認してください。",
  provider_not_ready:
    "Codex接続の準備を確認できません。プロバイダー設定の接続状態を確認してください。",
  authentication_required:
    "Codexの認証済み状態を確認できません。既存の接続状態を確認してください。",
  api_auth_unsupported:
    "Codex接続はAPIキー等の認証方式です。AutoはChatGPTサブスク認証だけに対応しています。API課金へは切り替えません。",
  auth_method_unconfirmed:
    "Codexの認証方式を確認できません。サブスク認証か確認できるまでAutoを停止します。",
  judge_model_unavailable:
    "Codex接続のモデル一覧にLuna（gpt-6-luna）がありません。モデル一覧を確認してください。別モデルへの自動切り替えはしません。",
  config_missing: "Codex接続の設定を見つけられません。接続一覧と設定の整合性を確認してください。",
  config_driver_mismatch:
    "Codex接続の設定が別のプロバイダーを参照しています。接続設定を確認してください。",
  config_invalid: "Codex接続の設定形式を確認できません。プロバイダー設定を確認してください。",
  managed_auth_unsupported:
    "このCodex接続はAmu管理のサブスク認証です。現在のAutoは既存Codex CLIのサブスク認証だけに対応しています。認証の再設定やAPI課金への切り替えは行いません。",
  choices_unavailable:
    "依頼を渡せるモデル候補がありません。利用可能モデルと選択状態を確認してください。",
  no_judge:
    "オートの判定に使えるAI（Claude・Codex・Cursor のサブスク接続）が見つかりません。プロバイダー設定の接続状態を確認してください。",
} as const;

export type LunaPreflightCode = keyof typeof lunaPreflightMessages;
export const lunaPreflightBlocked = (code: LunaPreflightCode) => ({
  ok: false as const,
  code,
  error: `${lunaPreflightMessages[code]} 依頼は保持しています。手動送信に戻してください。`,
});

/** The config map must be the same legacy/explicit map consumed by the provider registry. */
export function resolveLunaPreflight(
  providers: ReadonlyArray<ServerProvider>,
  configs: ProviderInstanceConfigMap,
  choices: ReadonlyArray<AutoChoice>,
) {
  const codex = providers.filter((p) => p.driver === "codex");
  if (!codex.length) return lunaPreflightBlocked("codex_missing");
  const enabled = codex.filter((p) => p.enabled);
  if (!enabled.length) return lunaPreflightBlocked("codex_disabled");
  const ready = enabled.filter((p) => p.status === "ready");
  if (!ready.length) return lunaPreflightBlocked("provider_not_ready");
  const authenticated = ready.filter((p) => p.auth.status === "authenticated");
  if (!authenticated.length) return lunaPreflightBlocked("authentication_required");
  const subscriptions = authenticated.filter((p) => p.auth.type === "chatgpt");
  if (!subscriptions.length)
    return lunaPreflightBlocked(
      authenticated.some((p) => p.auth.type) ? "api_auth_unsupported" : "auth_method_unconfirmed",
    );
  const judge = subscriptions.find((p) => p.models.some((m) => m.slug === LUNA_JUDGE_MODEL));
  if (!judge) return lunaPreflightBlocked("judge_model_unavailable");
  const instance = configs[judge.instanceId];
  if (!instance) return lunaPreflightBlocked("config_missing");
  if (instance.driver !== "codex") return lunaPreflightBlocked("config_driver_mismatch");
  let config: CodexSettings;
  try {
    config = decodeLunaPreflightConfig(instance.config ?? {});
  } catch {
    return lunaPreflightBlocked("config_invalid");
  }
  if (config.setupMode === "managed") return lunaPreflightBlocked("managed_auth_unsupported");
  if (!choices.length) return lunaPreflightBlocked("choices_unavailable");
  return { ok: true as const, judge, instance, config };
}

/** Why Haiku or Composer cannot judge here; Auto then asks the next judge. */
export type OtherJudgeSkip =
  | "missing"
  | "not_ready"
  | "not_subscription"
  | "config_invalid"
  | "custom_endpoint";

type OtherJudgeResult<Config> =
  | { ok: true; provider: ServerProvider; instance: ProviderInstanceConfig; config: Config }
  | { ok: false; skip: OtherJudgeSkip };

function readyProviders(providers: ReadonlyArray<ServerProvider>, driver: string) {
  return providers.filter(
    (p) =>
      p.driver === driver && p.enabled && p.status === "ready" && p.auth.status === "authenticated",
  );
}

/**
 * Claude judges with Haiku under a Claude subscription login. API keys,
 * Bedrock and logins whose kind is not reported are skipped, so Auto never
 * moves to paid API use.
 */
export function resolveClaudeJudge(
  providers: ReadonlyArray<ServerProvider>,
  configs: ProviderInstanceConfigMap,
): OtherJudgeResult<ClaudeSettings> {
  if (!providers.some((p) => p.driver === "claudeAgent")) return { ok: false, skip: "missing" };
  const ready = readyProviders(providers, "claudeAgent");
  if (!ready.length) return { ok: false, skip: "not_ready" };
  const subscription = ready.find(
    (p) => typeof p.auth.type === "string" && !["apiKey", "bedrock"].includes(p.auth.type),
  );
  if (!subscription) return { ok: false, skip: "not_subscription" };
  const instance = configs[subscription.instanceId];
  if (!instance || instance.driver !== "claudeAgent") return { ok: false, skip: "config_invalid" };
  try {
    return {
      ok: true,
      provider: subscription,
      instance,
      config: decodeClaudeConfig(instance.config ?? {}),
    };
  } catch {
    return { ok: false, skip: "config_invalid" };
  }
}

/** Cursor judges with Composer under the Cursor account login, not an API key. */
export function resolveCursorJudge(
  providers: ReadonlyArray<ServerProvider>,
  configs: ProviderInstanceConfigMap,
): OtherJudgeResult<CursorSettings> {
  if (!providers.some((p) => p.driver === "cursor")) return { ok: false, skip: "missing" };
  const usable = providers.filter((p) => p.driver === "cursor" && p.enabled && p.installed);
  if (!usable.length) return { ok: false, skip: "not_ready" };
  // Composer judges through the Cursor CLI and its own login, so a connection
  // not yet signed in here may still judge. A connection signed in with an API
  // key is skipped, so Auto never runs on API billing.
  const account =
    usable.find((p) => p.auth.status === "authenticated" && p.auth.type === "browser") ??
    usable.find((p) => p.auth.status !== "authenticated");
  if (!account) return { ok: false, skip: "not_subscription" };
  const instance = configs[account.instanceId];
  if (!instance || instance.driver !== "cursor") return { ok: false, skip: "config_invalid" };
  let config: CursorSettings;
  try {
    config = decodeCursorConfig(instance.config ?? {});
  } catch {
    return { ok: false, skip: "config_invalid" };
  }
  if (config.apiEndpoint) return { ok: false, skip: "custom_endpoint" };
  return { ok: true, provider: account, instance, config };
}
