import {
  CodexSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import type { ProviderPostUpdateCheck } from "../provider/providerMaintenanceRunner.ts";
import { checkJudgeCli, type JudgeCliCheck } from "./LunaDecision.ts";

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/** After a Codex CLI update, confirm the Luna judge arguments still start; other providers pass. */
export function makeLunaPostUpdateCheck<E>(
  getSettings: Effect.Effect<ServerSettings, E>,
  check: typeof checkJudgeCli = checkJudgeCli,
): ProviderPostUpdateCheck {
  return (input: { provider: ProviderDriverKind; instanceId: ProviderInstanceId }) =>
    Effect.gen(function* () {
      if (input.provider !== "codex") return { ok: true } as JudgeCliCheck;
      const settings = yield* getSettings;
      const instance = deriveProviderInstanceConfigMap(settings)[input.instanceId];
      if (!instance || instance.driver !== "codex") return { ok: true } as JudgeCliCheck;
      const config = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(config))
        return { ok: false, reason: "Codex接続の設定形式を確認できません。" } as JudgeCliCheck;
      const home = yield* HostProcess.HomeDirectory;
      const binary = expandHomePath(config.value.binaryPath, home);
      const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
      return yield* Effect.tryPromise({
        try: () => check(binary, environment),
        catch: () => "CLIの動作確認を実行できませんでした。",
      });
    }).pipe(
      Effect.catch((reason) =>
        Effect.succeed<JudgeCliCheck>({
          ok: false,
          reason: typeof reason === "string" ? reason : "CLIの動作確認を実行できませんでした。",
        }),
      ),
    );
}
