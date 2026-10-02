import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isProviderSettingsUpdateCandidate,
  isProviderUpdateActive,
} from "../ProviderUpdateLaunchNotification.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** CLIs with a one-click update, one row per instance. */
export function providerUpdateAvailableCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  if (providers.some(isProviderUpdateActive)) return [];
  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (!isProviderSettingsUpdateCandidate(provider) || seen.has(provider.instanceId)) return false;
    seen.add(provider.instanceId);
    return true;
  });
}

function providerVersionLine(provider: ServerProvider): string {
  const name = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const current = provider.versionAdvisory?.currentVersion ?? provider.version ?? "?";
  const latest = provider.versionAdvisory?.latestVersion ?? "最新版";
  return `${name}：${current} → ${latest}`;
}

/** Amu: a sidebar entry that starts CLI updates after an explicit confirmation. */
export function SidebarProviderUpdateAvailable() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const candidates = providerUpdateAvailableCandidates(providers);

  if (candidates.length === 0 || environmentId === null) return null;

  const runUpdates = async () => {
    setRunning(true);
    for (const candidate of candidates) {
      const result = await updateProvider({
        environmentId,
        input: { provider: candidate.driver, instanceId: candidate.instanceId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver} を更新できませんでした`,
            description: error instanceof Error ? error.message : "更新を開始できませんでした。",
          }),
        );
      }
    }
    setRunning(false);
    setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        className="flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg bg-sidebar-control-surface px-2 py-1.5 text-left text-2xs leading-4 font-medium text-sidebar-foreground hover:bg-sidebar-row-hover"
        onClick={() => setOpen(true)}
      >
        <DownloadIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 wrap-break-word">アップデート（{candidates.length}件）</span>
      </button>
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!running) setOpen(next);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>CLIを更新しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              次のCLIを更新します。更新後にAmuとの動作確認を行い、問題があれば自動で元の版に戻します。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="px-6 pb-4 text-sm">
            {candidates.map((candidate) => (
              <li key={candidate.instanceId}>{providerVersionLine(candidate)}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogClose disabled={running} render={<Button variant="outline" />}>
              キャンセル
            </AlertDialogClose>
            <Button disabled={running} onClick={() => void runUpdates()}>
              {running ? (
                <>
                  <Spinner size="sm" />
                  更新中…
                </>
              ) : (
                "更新する"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
