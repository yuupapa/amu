// @effect-diagnostics nodeBuiltinImport:off globalDate:off - reads the first part of recent history files, once per judgement.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Amu: where earlier work happened, so Auto can start a new request in the
 * folder it belongs to (docs/user/luna-auto.md). Folders come from Amu's own
 * projects (sent by the client), Claude Code's history (~/.claude/projects)
 * and Codex's (~/.codex/sessions). Only the working folder and the first
 * words of a few requests are read, from the start of the newest files.
 */

export type WorkFolder = {
  /** Short id the judge answers with ("f1", "f2", …). */
  id: string;
  path: string;
  lastUsedMs: number;
  /** A few earlier requests or thread titles there, shortened. */
  hints: string[];
};

export type AmuProjectFolder = { path: string; titles: string[]; updatedAtMs: number };

const MAX_FOLDERS = 20;
const MAX_HINTS = 3;
const HINT_LENGTH = 60;
const HEAD_BYTES = 96_000;

function readHead(file: string): string {
  let handle: number | null = null;
  try {
    handle = NodeFS.openSync(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = NodeFS.readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (handle !== null) NodeFS.closeSync(handle);
  }
}

function lines(text: string): unknown[] {
  const result: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line));
    } catch {
      // The last line of a head is usually cut off.
    }
  }
  return result;
}

/** A request as a short hint, or null for tool output, commands and system notes. */
export function hintFrom(text: unknown): string | null {
  const value =
    typeof text === "string"
      ? text
      : Array.isArray(text)
        ? (text as Array<{ type?: string; text?: unknown }>)
            .filter((part) => part?.type === "text" || part?.type === "input_text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join(" ")
        : "";
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean || /^<|^Caveat:|^\[Request interrupted|^This session is being continued/.test(clean))
    return null;
  return clean.length > HINT_LENGTH ? `${clean.slice(0, HINT_LENGTH - 1)}…` : clean;
}

type Found = { path: string; atMs: number; hint: string | null };

function newestFiles(directory: string, suffix: string, limit: number): string[] {
  try {
    return NodeFS.readdirSync(directory)
      .filter((name) => name.endsWith(suffix))
      .map((name) => {
        const file = NodePath.join(directory, name);
        try {
          return { file, at: NodeFS.statSync(file).mtimeMs };
        } catch {
          return { file, at: 0 };
        }
      })
      .toSorted((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

function mtime(file: string): number {
  try {
    return NodeFS.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Claude Code: one folder per project directory; the newest sessions give the hints. */
export function claudeCodeFolders(claudeHome: string): Found[] {
  const root = NodePath.join(claudeHome, "projects");
  let directories: string[] = [];
  try {
    directories = NodeFS.readdirSync(root).map((name) => NodePath.join(root, name));
  } catch {
    return [];
  }
  const found: Found[] = [];
  const newest = directories
    .map((directory) => ({ directory, at: mtime(directory) }))
    .toSorted((a, b) => b.at - a.at)
    .slice(0, 40);
  for (const { directory } of newest) {
    for (const file of newestFiles(directory, ".jsonl", 3)) {
      let cwd: string | null = null,
        hint: string | null = null;
      for (const entry of lines(readHead(file)) as Array<Record<string, unknown>>) {
        if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
        if (!hint && entry.type === "user") {
          const message = entry.message as { content?: unknown } | undefined;
          hint = hintFrom(message?.content);
        }
        if (cwd && hint) break;
      }
      if (cwd) found.push({ path: cwd, atMs: mtime(file), hint });
    }
  }
  return found;
}

/** Codex: sessions by day; the session's working folder and its first request. */
export function codexFolders(codexHome: string, limit = 150): Found[] {
  const root = NodePath.join(codexHome, "sessions");
  const files: string[] = [];
  const descend = (directory: string, depth: number) => {
    if (files.length >= limit) return;
    let names: string[] = [];
    try {
      names = NodeFS.readdirSync(directory).toSorted().toReversed();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= limit) return;
      const next = NodePath.join(directory, name);
      if (depth < 3) descend(next, depth + 1);
      else if (name.endsWith(".jsonl")) files.push(next);
    }
  };
  descend(root, 0);
  const found: Found[] = [];
  for (const file of files) {
    let cwd: string | null = null,
      hint: string | null = null;
    for (const entry of lines(readHead(file)) as Array<{ type?: string; payload?: unknown }>) {
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      if (!cwd && entry.type === "session_meta" && typeof payload.cwd === "string")
        cwd = payload.cwd;
      if (!hint && entry.type === "event_msg" && payload.type === "user_message")
        hint = hintFrom(payload.message);
      if (cwd && hint) break;
    }
    if (cwd) found.push({ path: cwd, atMs: mtime(file), hint });
  }
  return found;
}

/** Folders that are not a place to keep work: temporary, tool homes, the home folder itself. */
/** The folder's real location (links followed), or the plain resolved path when it is gone. */
export function realFolder(path: string): string {
  const resolved = NodePath.resolve(path);
  try {
    return NodeFS.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Whether a folder is a place to keep work. Compared by real location, so a
 * link into a temporary folder, a tool's home or Amu's own data is refused too.
 */
export function isWorkFolder(path: string, excluded: ReadonlyArray<string>): boolean {
  if (!NodePath.isAbsolute(path)) return false;
  let real: string;
  try {
    real = NodeFS.realpathSync(path);
    if (!NodeFS.statSync(real).isDirectory()) return false;
  } catch {
    return false;
  }
  const home = realFolder(NodeOS.homedir());
  if (real === NodePath.parse(real).root || real === home) return false;
  const inside = (root: string) => real === root || real.startsWith(`${root}${NodePath.sep}`);
  const refused = [
    NodeOS.tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    NodePath.join(home, ".codex"),
    NodePath.join(home, ".claude"),
    ...excluded,
  ].flatMap((root) => [NodePath.resolve(root), realFolder(root)]);
  return !refused.some(inside);
}

/**
 * The GitHub repositories a folder's Git checkout points at ("owner/name"),
 * which tell the judge what the folder is better than its path. Works for
 * linked worktrees too, whose `.git` is a file naming the real folder.
 */
export function repositoryNames(folder: string): string[] {
  try {
    let gitDirectory = NodePath.join(folder, ".git");
    if (NodeFS.statSync(gitDirectory).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(NodeFS.readFileSync(gitDirectory, "utf8"));
      if (!pointer) return [];
      gitDirectory = NodePath.resolve(folder, pointer[1]!.trim());
      try {
        const common = NodeFS.readFileSync(NodePath.join(gitDirectory, "commondir"), "utf8").trim();
        gitDirectory = NodePath.resolve(gitDirectory, common);
      } catch {
        // Not a linked worktree.
      }
    }
    const config = NodeFS.readFileSync(NodePath.join(gitDirectory, "config"), "utf8");
    const names = new Set<string>();
    for (const match of config.matchAll(/^\s*url\s*=\s*(\S+)/gm)) {
      const repository = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(match[1]!);
      if (repository) names.add(repository[1]!);
    }
    return [...names].slice(0, 4);
  } catch {
    return [];
  }
}

/** The newest work folders, merged across sources, with a few hints each. */
export function collectWorkFolders(input: {
  amuProjects: ReadonlyArray<AmuProjectFolder>;
  found: ReadonlyArray<Found>;
  excluded: ReadonlyArray<string>;
}): WorkFolder[] {
  const byPath = new Map<string, { lastUsedMs: number; hints: string[] }>();
  const add = (path: string, atMs: number, hints: ReadonlyArray<string | null>) => {
    const key = realFolder(path);
    const entry = byPath.get(key) ?? { lastUsedMs: 0, hints: [] };
    entry.lastUsedMs = Math.max(entry.lastUsedMs, atMs);
    for (const hint of hints)
      if (hint && entry.hints.length < MAX_HINTS && !entry.hints.includes(hint))
        entry.hints.push(hint);
    byPath.set(key, entry);
  };
  for (const project of input.amuProjects)
    add(
      project.path,
      project.updatedAtMs,
      project.titles.map((title) => hintFrom(title)),
    );
  for (const item of input.found.toSorted((a, b) => b.atMs - a.atMs))
    add(item.path, item.atMs, [item.hint]);
  const kept = [...byPath.entries()].filter(([path]) => isWorkFolder(path, input.excluded));
  // A folder inside another one (an output folder of a project) is that project's work.
  const paths = kept.map(([path]) => path);
  return kept
    .filter(
      ([path]) =>
        !paths.some((other) => other !== path && path.startsWith(`${other}${NodePath.sep}`)),
    )
    .toSorted(([, a], [, b]) => b.lastUsedMs - a.lastUsedMs)
    .slice(0, MAX_FOLDERS)
    .map(([path, entry], index) => ({
      id: `f${index + 1}`,
      path,
      lastUsedMs: entry.lastUsedMs,
      hints: entry.hints,
    }));
}

/** What the judge sees: home shortened to ~, the day of last use, and the hints. */
export function folderChoicesForJudge(folders: ReadonlyArray<WorkFolder>, current: string | null) {
  const home = NodeOS.homedir();
  const short = (path: string) =>
    path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  return {
    current: current ? short(current) : null,
    folders: folders.map((folder) => ({
      id: folder.id,
      path: short(folder.path),
      lastUsed: new Date(folder.lastUsedMs).toISOString().slice(0, 10),
      repositories: repositoryNames(folder.path),
      examples: folder.hints,
      isCurrent: current !== null && realFolder(current) === folder.path,
    })),
  };
}
