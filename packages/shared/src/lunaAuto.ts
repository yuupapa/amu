import type { ServerProvider } from "@t3tools/contracts";

export const LUNA_JUDGE_MODEL = "gpt-6-luna";
export const LUNA_CLAUDE_JUDGE_MODEL = "claude-haiku-5-5";
export const LUNA_CURSOR_JUDGE_MODEL = "composer-2.5";

/**
 * Who may judge for Auto, in the default order (結パパ, 2026-10-08): the first
 * connected one judges, and when it fails the next one tries. Each judges
 * under its subscription login only.
 */
export type LunaJudgeKind = "claude" | "codex" | "cursor";
export const LUNA_JUDGE_ORDER: ReadonlyArray<LunaJudgeKind> = ["claude", "codex", "cursor"];
export const LUNA_JUDGE_NAMES: Readonly<Record<LunaJudgeKind, string>> = {
  claude: "Haiku",
  codex: "Luna",
  cursor: "Composer",
};
export type AutoChoice = {
  instanceId: string;
  model: string;
  name: string;
  driver: string;
  effortId: string | null;
  efforts: string[];
};
export type AutoDecision = {
  model: string;
  effort: string;
  reason: string;
  /** Only when work folders were offered: a folder id, "current" or "new". */
  folder?: string;
};
/** What the judge may answer for the work folder, besides a folder's id. */
export const AUTO_FOLDER_CURRENT = "current";
export const AUTO_FOLDER_NEW = "new";

/** Use the same advertised descriptors as manual selection; no invented effort values. */
export function autoChoices(providers: ReadonlyArray<ServerProvider>): AutoChoice[] {
  const seen = new Set<string>();
  return providers
    .filter((p) => p.enabled && p.status === "ready" && p.auth.status === "authenticated")
    .flatMap((p) =>
      p.models
        .filter((m) => !m.isCustom && !m.isLegacy)
        .flatMap((m) => {
          if (seen.has(m.slug)) return [];
          seen.add(m.slug);
          const descriptor = m.capabilities?.optionDescriptors?.find(
            (d) => d.type === "select" && ["reasoningEffort", "effort"].includes(d.id),
          );
          return [
            {
              instanceId: p.instanceId,
              driver: p.driver,
              model: m.slug,
              name: m.name,
              effortId: descriptor?.id ?? null,
              efforts:
                descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : ["default"],
            },
          ];
        }),
    )
    .filter((c) => c.efforts.length > 0)
    .slice(0, 64);
}

export function validateAutoDecision(
  value: unknown,
  choices: ReadonlyArray<AutoChoice>,
  folderIds?: ReadonlyArray<string>,
): AutoDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("オートの判定形式が不正です。");
  const v = value as Record<string, unknown>;
  const model = v.model,
    effort = v.effort;
  if (
    Object.keys(v).sort().join(",") !==
      (folderIds ? "effort,folder,model,reason" : "effort,model,reason") ||
    (folderIds !== undefined &&
      (typeof v.folder !== "string" ||
        ![...folderIds, AUTO_FOLDER_CURRENT, AUTO_FOLDER_NEW].includes(v.folder))) ||
    typeof v.model !== "string" ||
    typeof v.effort !== "string" ||
    typeof v.reason !== "string" ||
    !v.reason.trim() ||
    v.reason.length > 160 ||
    !/[ぁ-んァ-ヶ一-龯]/u.test(v.reason) ||
    !choices.some(
      (c) => c.model === model && typeof effort === "string" && c.efforts.includes(effort),
    )
  )
    throw new Error(
      "オートが選んだモデル・思考の強さ・理由を確認できません。手動で選んで送信してください。",
    );
  return {
    model: v.model,
    effort: v.effort,
    reason: v.reason.trim(),
    ...(folderIds ? { folder: v.folder as string } : {}),
  };
}

export function autoOutputSchema(
  choices: ReadonlyArray<AutoChoice>,
  folderIds?: ReadonlyArray<string>,
) {
  return {
    type: "object",
    additionalProperties: false,
    required: folderIds ? ["model", "effort", "reason", "folder"] : ["model", "effort", "reason"],
    properties: {
      model: { type: "string", enum: choices.map((c) => c.model) },
      effort: { type: "string", enum: [...new Set(choices.flatMap((c) => c.efforts))] },
      reason: { type: "string" },
      ...(folderIds
        ? {
            folder: {
              type: "string",
              enum: [...folderIds, AUTO_FOLDER_CURRENT, AUTO_FOLDER_NEW],
            },
          }
        : {}),
    },
  };
}

export function isNewAutoRequest(input: {
  enabled: boolean;
  hasSession: boolean;
  hasUserMessage: boolean;
  contextCount: number;
  multipleModels: boolean;
}) {
  return (
    input.enabled &&
    !input.hasSession &&
    !input.hasUserMessage &&
    input.contextCount === 0 &&
    !input.multipleModels
  );
}
