// @effect-diagnostics nodeBuiltinImport:off - one small JSON file beside the other Amu files, read and written per request.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Amu: which project a thread is shown under in the sidebar, when that is not
 * the project it works in (docs/user/thread-sidebar.md). Only the listing
 * changes: the thread keeps its project, folder and provider sessions, so it
 * can be continued as before. Kept in the server's state folder, so every
 * client of this machine shows the same.
 */

const FILE = "thread-folders.json";
const MAX_ENTRIES = 5_000;
const ID = /^[A-Za-z0-9:%._~-]{1,800}$/u;

export type ThreadFolderEntries = Readonly<Record<string, string>>;

export const isThreadFolderId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

export function readThreadFolders(stateDir: string): ThreadFolderEntries {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, FILE), "utf8"));
    if (!value || typeof value !== "object") return {};
    const entries = (value as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {};
    const result: Record<string, string> = {};
    for (const [threadId, projectId] of Object.entries(entries)) {
      if (isThreadFolderId(threadId) && isThreadFolderId(projectId)) result[threadId] = projectId;
    }
    return result;
  } catch {
    return {};
  }
}

/** Shows `threadId` under `projectId`, or back under its own project with null. */
export function setThreadFolder(
  stateDir: string,
  threadId: string,
  projectId: string | null,
): ThreadFolderEntries {
  const entries: Record<string, string> = { ...readThreadFolders(stateDir) };
  if (projectId === null) delete entries[threadId];
  else entries[threadId] = projectId;
  const kept = Object.fromEntries(Object.entries(entries).slice(-MAX_ENTRIES));
  const file = NodePath.join(stateDir, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ version: 1, entries: kept }), { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
  return kept;
}
