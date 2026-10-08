import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import type { AutoFolderContext } from "./useLunaAuto";

/**
 * Amu: what Auto tells the server about this machine's projects, so the judge
 * can start a new request in the folder it belongs to (docs/user/luna-auto.md).
 * Each project gives its folder, when it was last used and a few thread titles.
 * No-project (scratch) folders are left out: each is one past thread's own.
 */
export function buildAutoFolderContext(input: {
  activeProject: EnvironmentProject | null;
  projects: ReadonlyArray<EnvironmentProject>;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  isScratch: (project: EnvironmentProject) => boolean;
}): AutoFolderContext | null {
  const active = input.activeProject;
  if (!active) return null;
  const sameMachine = input.projects.filter(
    (project) => project.environmentId === active.environmentId && !input.isScratch(project),
  );
  const projects = sameMachine.slice(0, 200).map((project) => {
    const threads = input.threads
      .filter(
        (thread) =>
          thread.environmentId === project.environmentId &&
          thread.projectId === project.id &&
          thread.archivedAt === null,
      )
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      path: project.workspaceRoot,
      titles: threads.slice(0, 5).map((thread) => thread.title),
      updatedAt: threads[0]?.updatedAt ?? project.updatedAt,
    };
  });
  return { current: input.isScratch(active) ? null : active.workspaceRoot, projects };
}

/** The folder's own name, for "（フォルダー：…）". */
export function folderDisplayName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Resolves once `ready()` holds, or false after `timeoutMs`. */
export function waitUntil(ready: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (ready()) return resolve(true);
      if (performance.now() - started > timeoutMs) return resolve(false);
      window.setTimeout(check, 30);
    };
    check();
  });
}
