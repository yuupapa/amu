import { useEffect } from "react";

import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettingsHydrated,
} from "../hooks/useSettings";

/**
 * Amu turns on a few upstream settings that are off by default. Each is turned
 * on once, when the version that adds it first starts; switching it off in
 * Settings afterwards is kept. A once-flag is written only after the setting
 * is saved, so a failed save is tried again at the next start.
 *
 * - legacySidebarEnabled: threads listed per project, folded under each
 *   project like Codex and Claude (docs/user/thread-sidebar.md).
 * - planModeEnabled: plan mode, chosen from the composer's access menu
 *   (docs/user/composer.md).
 */
const AMU_SETTING_DEFAULTS = [
  { storageKey: "amu:sidebar-tree-default:v1", setting: "legacySidebarEnabled" },
  { storageKey: "amu:plan-mode-default:v1", setting: "planModeEnabled" },
] as const;

const running = new Set<string>();

export function useAmuSettingDefaults(): void {
  const hydrated = useClientSettingsHydrated();
  useEffect(() => {
    if (!hydrated) return;
    for (const { storageKey, setting } of AMU_SETTING_DEFAULTS) {
      if (running.has(storageKey)) continue;
      try {
        if (window.localStorage.getItem(storageKey) !== null) continue;
      } catch {
        return;
      }
      const markDone = () => {
        try {
          window.localStorage.setItem(storageKey, new Date().toISOString());
        } catch {
          // Tried again at the next start.
        }
      };
      if (getClientSettings()[setting]) {
        markDone();
        continue;
      }
      running.add(storageKey);
      // This save reports failure, so the flag is written only once it is on disk.
      void persistClientSettingsUpdate((current) => ({ ...current, [setting]: true }))
        .then(markDone, () => undefined)
        .finally(() => {
          running.delete(storageKey);
        });
    }
  }, [hydrated]);
}
