// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - lstat/readlink walks are not reachable through Effect FileSystem; plain async with a wall-clock limit.
/**
 * Path checks for folders Amu Creator serves.
 *
 * HyperFrames 0.8.143 follows symlinks inside the project it previews, so a
 * project could carry a link that serves files from outside it (for example
 * the Creator state folder). Before a folder is served, `scanForOutwardLinks`
 * walks it without following links and refuses it if any link resolves
 * outside. Links added after the scan come from a process running as the same
 * user, which is outside the threat model (see `creatorFiles.ts`).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * The real path of `target` when it lies inside the real path of `workspace`,
 * else `null`. A relative `target` is taken from `workspace`. Both sides are
 * `realpath`ed first, so `..`, a link inside the workspace pointing out, and a
 * workspace reached through a link (macOS `/tmp`, `/var`) are all judged by
 * where they really are. A path that does not exist is refused.
 *
 * `WorkspaceFileSystem.resolveReadTarget` is not used here: it does not check
 * that an absolute path stays inside the workspace.
 */
export const realPathInside = async (workspace: string, target: string): Promise<string | null> => {
  let realWorkspace: string;
  let realTarget: string;
  try {
    realWorkspace = await NodeFSP.realpath(workspace);
    realTarget = await NodeFSP.realpath(NodePath.resolve(realWorkspace, target));
  } catch {
    return null;
  }
  const relative = NodePath.relative(realWorkspace, realTarget);
  if (relative === "") return realTarget;
  const escapes =
    relative === ".." || relative.startsWith(`..${NodePath.sep}`) || NodePath.isAbsolute(relative);
  return escapes ? null : realTarget;
};

export const isInsideRealRoot = async (workspace: string, target: string): Promise<boolean> =>
  (await realPathInside(workspace, target)) !== null;

export interface LinkScanOptions {
  readonly maxEntries?: number;
  readonly timeoutMs?: number;
}

export type LinkScanResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "outward_link" | "unreadable"; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: "too_many_entries" | "timeout" | "not_directory";
    };

export const LINK_SCAN_LIMITS = { maxEntries: 20_000, timeoutMs: 5_000 } as const;

const isInside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(NodePath.sep) ? root : `${root}${NodePath.sep}`);

class ScanStop extends Error {
  readonly result: Exclude<LinkScanResult, { ok: true }>;
  constructor(result: Exclude<LinkScanResult, { ok: true }>) {
    super(result.reason);
    this.result = result;
  }
}

const errno = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * Judges a dangling link (its target does not exist yet) by walking its target
 * text one component at a time from the link's real folder, the way the kernel
 * would. A `..` is applied to a real folder, so it cannot be fooled by a link the
 * way a lexical `path.resolve` can. Refused when an existing component is itself
 * a link or cannot be checked, or when a `..` follows a missing component.
 */
const danglingStaysInside = async (root: string, linkPath: string): Promise<boolean> => {
  const target = await NodeFSP.readlink(linkPath);
  let current = NodePath.isAbsolute(target)
    ? NodePath.parse(target).root
    : await NodeFSP.realpath(NodePath.dirname(linkPath));
  let missing = false;
  for (const part of target.split(NodePath.sep)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (missing) return false;
      current = NodePath.dirname(current);
      continue;
    }
    current = NodePath.join(current, part);
    if (missing) continue;
    try {
      if ((await NodeFSP.lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if (errno(error) !== "ENOENT") return false;
      missing = true;
    }
  }
  return isInside(root, current);
};

/**
 * Whether a link at `linkPath` (inside `root`) ends up inside `root`. Throws
 * (the scan reports `unreadable`) when it cannot be resolved for any reason
 * other than a missing target, such as a loop or a permission error.
 */
const linkStaysInside = async (root: string, linkPath: string): Promise<boolean> => {
  try {
    return isInside(root, await NodeFSP.realpath(linkPath));
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
    return danglingStaysInside(root, linkPath);
  }
};

/**
 * Walks `root` (node_modules included) with `lstat` semantics and refuses it if
 * any symlink resolves outside it, if it holds more than `maxEntries` entries,
 * or if the walk takes longer than `timeoutMs`.
 */
export const scanForOutwardLinks = async (
  root: string,
  options: LinkScanOptions = {},
): Promise<LinkScanResult> => {
  const maxEntries = options.maxEntries ?? LINK_SCAN_LIMITS.maxEntries;
  const timeoutMs = options.timeoutMs ?? LINK_SCAN_LIMITS.timeoutMs;
  // @effect-diagnostics-next-line globalDate:off
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const walk = async (): Promise<LinkScanResult> => {
    let realRoot: string;
    try {
      realRoot = await NodeFSP.realpath(root);
      if (!(await NodeFSP.lstat(realRoot)).isDirectory()) {
        return { ok: false, reason: "not_directory" };
      }
    } catch {
      return { ok: false, reason: "not_directory" };
    }
    const queue = [realRoot];
    let entries = 0;
    while (queue.length > 0) {
      // @effect-diagnostics-next-line globalDate:off
      if (stopped || Date.now() >= deadline) throw new ScanStop({ ok: false, reason: "timeout" });
      const dir = queue.shift()!;
      let listing;
      try {
        listing = await NodeFSP.readdir(dir, { withFileTypes: true });
      } catch {
        // A folder we cannot list could hide a link, so it is refused too.
        return { ok: false, reason: "unreadable", path: dir };
      }
      for (const entry of listing) {
        entries += 1;
        if (entries > maxEntries) throw new ScanStop({ ok: false, reason: "too_many_entries" });
        const path = NodePath.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          let inside: boolean;
          try {
            inside = await linkStaysInside(realRoot, path);
          } catch {
            return { ok: false, reason: "unreadable", path };
          }
          if (!inside) {
            return { ok: false, reason: "outward_link", path };
          }
        } else if (entry.isDirectory()) {
          queue.push(path);
        }
      }
    }
    return { ok: true };
  };

  // The race also bounds a single filesystem call that hangs.
  const timeout = new Promise<LinkScanResult>((resolve) => {
    timer = setTimeout(() => {
      stopped = true;
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      walk().catch((error: unknown) => {
        if (error instanceof ScanStop) return error.result;
        throw error;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};
