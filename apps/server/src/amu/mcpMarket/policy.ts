import type { ProviderAdapterV2RuntimePolicy } from "../../orchestration-v2/ProviderAdapter.ts";
import {
  permissionModeForClaudeRuntimePolicy,
  sandboxPolicyKindForClaudeRuntimePolicy,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexRuntimeModeTurnDefaults } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";

/**
 * Amu MCP market: whether a thread may use market tools right now
 * (docs/internals/amu-mcp-market.md, "Effective policy"). It asks the same
 * functions the Claude and Codex adapters use to set up a turn, so the proxy
 * and the AI cannot disagree about read-only. Refused: plan mode, a read-only
 * sandbox (Codex's Supervised runs read-only), and Claude in its own plan
 * mode. Anything else follows the AI's own permission handling. Unknown
 * drivers are refused.
 */
export function marketAllowsOutsideActions(input: {
  readonly driver: string;
  readonly policy: ProviderAdapterV2RuntimePolicy;
  /** Claude's mode as its CLI last reported it; undefined when unknown. */
  readonly claudeLivePermissionMode?: string | undefined;
}): boolean {
  const { driver, policy } = input;
  if (policy.interactionMode === "plan") return false;
  if (driver === "codex") {
    const sandbox =
      policy.sandboxPolicy !== undefined &&
      typeof policy.sandboxPolicy === "object" &&
      policy.sandboxPolicy !== null &&
      "type" in policy.sandboxPolicy
        ? String((policy.sandboxPolicy as { type: unknown }).type)
        : codexRuntimeModeTurnDefaults(policy.runtimeMode).sandboxPolicy.type;
    return sandbox !== "readOnly";
  }
  if (driver === "claudeAgent") {
    if (sandboxPolicyKindForClaudeRuntimePolicy(policy) === "readOnly") return false;
    if (permissionModeForClaudeRuntimePolicy(policy) === "plan") return false;
    if (input.claudeLivePermissionMode === undefined) return false;
    return input.claudeLivePermissionMode !== "plan";
  }
  return false;
}

/** Claude's live permission mode per provider MCP session, published by the Claude adapter. */
const claudeLiveModes = new Map<string, string>();

export function setClaudeLivePermissionMode(providerSessionId: string, mode: string | undefined) {
  if (mode === undefined) claudeLiveModes.delete(providerSessionId);
  else claudeLiveModes.set(providerSessionId, mode);
}

export const claudeLivePermissionMode = (providerSessionId: string) =>
  claudeLiveModes.get(providerSessionId);
