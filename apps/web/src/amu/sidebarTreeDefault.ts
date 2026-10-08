import { useEffect } from "react";

import {
  getClientSettings,
  persistClientSettingsUpdate,
  useClientSettingsHydrated,
} from "../hooks/useSettings";

/**
 * Amu: the sidebar lists threads per project by default, folded under each
 * project like Codex and Claude (docs/user/thread-sidebar.md). Upstream calls
 * this the legacy sidebar. Turned on once, when this version first starts;
 * switching it off in Settings afterwards is kept. The once-flag is written
 * only after the setting is saved, so a failed save is tried again.
 */

const STORAGE_KEY = "amu:sidebar-tree-default:v1";
let running = false;

export function useSidebarTreeByDefault(): void {
  const hydrated = useClientSettingsHydrated();
  useEffect(() => {
    if (!hydrated || running) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
    } catch {
      return;
    }
    const markDone = () => {
      try {
        window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
      } catch {
        // Tried again at the next start.
      }
    };
    if (getClientSettings().legacySidebarEnabled) {
      markDone();
      return;
    }
    running = true;
    // This save reports failure, so the flag is written only once it is on disk.
    void persistClientSettingsUpdate((current) => ({ ...current, legacySidebarEnabled: true }))
      .then(markDone, () => undefined)
      .finally(() => {
        running = false;
      });
  }, [hydrated]);
}
