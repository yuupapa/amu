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

/** The choices and their revision, which every save raises by one. */
export type ThreadFolderState = { entries: ThreadFolderEntries; revision: number };

export function readThreadFolderState(stateDir: string): ThreadFolderState {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(NodePath.join(stateDir, FILE), "utf8"));
    if (!value || typeof value !== "object") return { entries: {}, revision: 0 };
    const record = value as { entries?: unknown; revision?: unknown };
    const revision =
      typeof record.revision === "number" && Number.isSafeInteger(record.revision)
        ? Math.max(0, record.revision)
        : 0;
    const entries = record.entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries))
      return { entries: {}, revision };
    const result: Record<string, string> = {};
    for (const [threadId, projectId] of Object.entries(entries)) {
      if (isThreadFolderId(threadId) && isThreadFolderId(projectId)) result[threadId] = projectId;
    }
    return { entries: result, revision };
  } catch {
    return { entries: {}, revision: 0 };
  }
}

export function readThreadFolders(stateDir: string): ThreadFolderEntries {
  return readThreadFolderState(stateDir).entries;
}

/** Lists `threadId` under `projectId`, or back under its own project with null. */
export function setThreadFolder(
  stateDir: string,
  threadId: string,
  projectId: string | null,
): ThreadFolderState {
  const current = readThreadFolderState(stateDir);
  const entries: Record<string, string> = { ...current.entries };
  if (projectId === null) delete entries[threadId];
  else entries[threadId] = projectId;
  const kept = Object.fromEntries(Object.entries(entries).slice(-MAX_ENTRIES));
  const revision = current.revision + 1;
  const file = NodePath.join(stateDir, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify({ version: 1, revision, entries: kept }), {
    mode: 0o600,
  });
  NodeFS.renameSync(temporary, file);
  return { entries: kept, revision };
}
