// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a short in-memory reuse of the history scan.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AUTO_FOLDER_CURRENT, AUTO_FOLDER_NEW } from "@t3tools/shared/lunaAuto";

import {
  claudeCodeFolders,
  codexFolders,
  collectWorkFolders,
  folderChoicesForJudge,
  type AmuProjectFolder,
} from "./WorkFolders.ts";

/** Where Auto starts the request: a folder from earlier work, the current project, or a new one. */
export type FolderAnswer = { kind: "path"; path: string } | { kind: "current" } | { kind: "new" };

const SCAN_REUSE_MS = 60_000;
let scan: { at: number; found: ReturnType<typeof claudeCodeFolders> } | null = null;

/** Claude Code's and Codex's history, read at most once a minute. */
function historyFolders(now = Date.now()) {
  if (scan && now - scan.at < SCAN_REUSE_MS) return scan.found;
  const home = NodeOS.homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(home, ".claude");
  const codexHome = process.env.CODEX_HOME?.trim() || NodePath.join(home, ".codex");
  const found = [...claudeCodeFolders(claudeHome), ...codexFolders(codexHome)];
  scan = { at: now, found };
  return found;
}

/** The client's projects, kept only when every field has the expected shape and size. */
export function readAmuProjects(
  value: unknown,
): { current: string | null; projects: AmuProjectFolder[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { current?: unknown; projects?: unknown };
  const current =
    typeof record.current === "string" &&
    NodePath.isAbsolute(record.current) &&
    record.current.length <= 4096
      ? record.current
      : null;
  if (!Array.isArray(record.projects)) return null;
  const projects: AmuProjectFolder[] = [];
  for (const item of record.projects.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    const { path, titles, updatedAt } = item as {
      path?: unknown;
      titles?: unknown;
      updatedAt?: unknown;
    };
    if (typeof path !== "string" || !NodePath.isAbsolute(path) || path.length > 4096) continue;
    const updatedAtMs = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
    projects.push({
      path,
      titles: Array.isArray(titles)
        ? titles
            .filter((title): title is string => typeof title === "string")
            .slice(0, 5)
            .map((title) => title.slice(0, 120))
        : [],
      updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    });
  }
  return { current, projects };
}

/**
 * The folders the judge may pick, and how to turn its answer back into a
 * place. Amu's own data folder (where no-project threads live) is never
 * offered. Null when the client sent nothing usable or there is nothing to pick.
 */
export function judgeFoldersFromRequest(value: unknown, stateDir: string) {
  const request = readAmuProjects(value);
  if (!request) return null;
  const folders = collectWorkFolders({
    amuProjects: request.projects,
    found: historyFolders(),
    excluded: [NodePath.dirname(stateDir)],
  });
  if (folders.length === 0) return null;
  const current = request.current ? NodePath.resolve(request.current) : null;
  return {
    judge: {
      ids: folders.map((folder) => folder.id),
      view: folderChoicesForJudge(folders, current),
    },
    resolve(answer: string): FolderAnswer {
      if (answer === AUTO_FOLDER_NEW) return { kind: "new" };
      const folder = folders.find((candidate) => candidate.id === answer);
      if (answer === AUTO_FOLDER_CURRENT || !folder || folder.path === current)
        return { kind: "current" };
      return { kind: "path", path: folder.path };
    },
  };
}
