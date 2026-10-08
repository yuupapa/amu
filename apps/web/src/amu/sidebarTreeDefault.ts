import { useEffect } from "react";

import { persistClientSettingsPatch, useClientSettingsHydrated } from "../hooks/useSettings";

/**
 * Amu: the sidebar lists threads per project by default, folded under each
 * project like Codex and Claude (docs/user/thread-sidebar.md). Upstream calls
 * this the legacy sidebar. Turned on once, when this version first starts;
 * switching it off in Settings afterwards is kept.
 */

const STORAGE_KEY = "amu:sidebar-tree-default:v1";

export function useSidebarTreeByDefault(): void {
  const hydrated = useClientSettingsHydrated();
  useEffect(() => {
    if (!hydrated) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== null) return;
      window.localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      return;
    }
    void persistClientSettingsPatch({ legacySidebarEnabled: true });
  }, [hydrated]);
}
