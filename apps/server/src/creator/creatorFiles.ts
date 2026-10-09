// @effect-diagnostics nodeBuiltinImport:off - O_NOFOLLOW and O_EXCL are not reachable through Effect FileSystem.
/**
 * Safe file I/O for the Amu Creator store, all under `<stateDir>/creator/`.
 *
 * Threat model: what we defend against is the contents of the reviewed project
 * (files the AI or an outside source put there, and the JS of the HyperFrames
 * page). Those contents never get a path into the state folder, but they could
 * carry symlinks, so every directory level is recorded with `lstat` (dev + ino)
 * when opened and re-checked right before each write, and files are opened with
 * `O_NOFOLLOW` (and `O_EXCL` when created). Any other process running as the
 * same user is out of scope: it can already write anywhere we can. The check
 * and the following `open`/`rename` still leave a tiny window; under this
 * threat model nothing can reach that window.
 *
 * Node's `fs` is used directly because Effect's `FileSystem` has no way to pass
 * `O_NOFOLLOW` or `O_EXCL` (same reason as `fdReadStream.ts`). The functions are
 * plain async; CreatorService wraps them in Effect.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { CREATOR_LIMITS, CreatorStoreFile, type CreatorShotRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { emptyCreatorState } from "./creatorState.ts";

const { constants } = NodeFS;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const PROJECT_ID = /^[a-f0-9]{32}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const COMMENT_ID = new RegExp(`^${UUID}$`);
/** Revision is a positive integer with no leading zero, so parse and format round-trip. */
const SHOT_FILE = new RegExp(`^(${UUID})-r([1-9]\\d*)\\.png$`);
const STORE_FILE = "comments.json";

export type CreatorFileErrorReason =
  | "invalid_name"
  | "unsafe_path"
  | "too_large"
  | "exists"
  | "not_found"
  | "over_budget"
  | "hash_mismatch"
  | "evict_failed";

export class CreatorFileError extends Error {
  readonly reason: CreatorFileErrorReason;
  /** Shots already removed when a `writeShot` eviction failed midway; the caller clears them from state. */
  readonly evicted: ReadonlyArray<ShotName>;
  constructor(
    reason: CreatorFileErrorReason,
    message: string,
    options?: { cause?: unknown; evicted?: ReadonlyArray<ShotName> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CreatorFileError";
    this.reason = reason;
    this.evicted = options?.evicted ?? [];
  }
}

/** A directory as it was when opened. `dev`/`ino` are bigint so large inodes compare exactly. */
export interface DirStamp {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

export type CreatorRoot = DirStamp;

/** `path` is `<root>/projects/<projectId>` and holds `comments.json`. */
export interface ProjectStore extends DirStamp {
  /** `<project>/shots`. */
  readonly shots: DirStamp;
  /** Verified before the project folder itself: the root and `projects/`. */
  readonly ancestors: ReadonlyArray<DirStamp>;
}

/** Just enough of a `CreatorShotRef` to name the file. */
export type ShotName = Pick<CreatorShotRef, "commentId" | "revision">;

export interface StoreWriteHooks {
  readonly beforeOpenTemp?: () => Promise<void>;
  readonly beforeRename?: () => Promise<void>;
}

export interface ShotWriteOptions {
  /**
   * Shots of confirmed comments the caller allows to be removed, oldest first,
   * if the project's 50MB total would otherwise be exceeded.
   */
  readonly evictable: ReadonlyArray<ShotName>;
  readonly hooks?: { readonly beforeOpen?: () => Promise<void> };
}

export interface ShotWriteResult {
  readonly sha256: string;
  readonly bytes: number;
  /** Refs whose files were removed to make room; the caller clears them from state. */
  readonly evicted: ReadonlyArray<ShotName>;
}

const errno = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

const unsafe = (message: string, cause?: unknown) =>
  new CreatorFileError("unsafe_path", message, cause === undefined ? undefined : { cause });

/** Re-reads one directory with `lstat` and requires the same dev/ino and no symlink. */
export const verifyDir = async (stamp: DirStamp): Promise<void> => {
  let stats;
  try {
    stats = await NodeFSP.lstat(stamp.path, { bigint: true });
  } catch (cause) {
    throw unsafe(`Creator folder is gone: ${stamp.path}`, cause);
  }
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.dev !== stamp.dev ||
    stats.ino !== stamp.ino
  ) {
    throw unsafe(`Creator folder changed: ${stamp.path}`);
  }
};

const verifyJsonDirs = async (store: ProjectStore) => {
  for (const dir of store.ancestors) await verifyDir(dir);
  await verifyDir(store);
};
const verifyShotDirs = async (store: ProjectStore) => {
  await verifyJsonDirs(store);
  await verifyDir(store.shots);
};

/** Creates the directory if needed (0o700), then records it. Refuses a symlink or non-directory. */
export const ensureDir = async (path: string): Promise<DirStamp> => {
  try {
    await NodeFSP.mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (errno(cause) !== "EEXIST") throw cause;
  }
  const stats = await NodeFSP.lstat(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafe(`Creator path is not a plain directory: ${path}`);
  }
  return { path, dev: stats.dev, ino: stats.ino };
};

export const openCreatorRoot = async (stateDir: string): Promise<CreatorRoot> => {
  await NodeFSP.mkdir(stateDir, { recursive: true });
  return ensureDir(NodePath.join(stateDir, "creator"));
};

export const openProjectStore = async (
  root: CreatorRoot,
  projectId: string,
): Promise<ProjectStore> => {
  if (!PROJECT_ID.test(projectId)) {
    throw new CreatorFileError("invalid_name", "projectId must be 32 lowercase hex characters");
  }
  await verifyDir(root);
  const projects = await ensureDir(NodePath.join(root.path, "projects"));
  const project = await ensureDir(NodePath.join(projects.path, projectId));
  const shots = await ensureDir(NodePath.join(project.path, "shots"));
  return { ...project, shots, ancestors: [root, projects] };
};

/** The one serialization used for both the size check and the bytes written. */
const serializeStore = (state: CreatorStoreFile): Buffer => Buffer.from(JSON.stringify(state));

const decodeStore = Schema.decodeUnknownSync(CreatorStoreFile);

const moveAside = async (store: ProjectStore): Promise<void> => {
  await verifyJsonDirs(store);
  // @effect-diagnostics-next-line globalDate:off
  const stamp = Date.now();
  for (let n = 0; ; n += 1) {
    const target = NodePath.join(
      store.path,
      `comments.broken-${stamp}${n === 0 ? "" : `-${n}`}.json`,
    );
    try {
      await NodeFSP.lstat(target);
    } catch (cause) {
      if (errno(cause) !== "ENOENT") throw cause;
      await NodeFSP.rename(NodePath.join(store.path, STORE_FILE), target);
      return;
    }
  }
};

/**
 * Reads `comments.json`. Missing -> empty state. Corrupt (bad JSON or schema-invalid)
 * -> moved to `comments.broken-<time>.json`, then empty state. Larger than 4MB, or
 * not a regular file (a symlink fails the `O_NOFOLLOW` open) -> refused, left in place.
 */
export const readStore = async (store: ProjectStore): Promise<CreatorStoreFile> => {
  await verifyJsonDirs(store);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      NodePath.join(store.path, STORE_FILE),
      constants.O_RDONLY | O_NOFOLLOW,
    );
  } catch (cause) {
    if (errno(cause) === "ENOENT") return emptyCreatorState();
    if (errno(cause) === "ELOOP") throw unsafe("comments.json is a symlink", cause);
    throw cause;
  }
  let text: string;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw unsafe("comments.json is not a regular file");
    if (stats.size > CREATOR_LIMITS.maxStoreBytes) {
      throw new CreatorFileError("too_large", "comments.json is larger than the store limit");
    }
    const data = await handle.readFile();
    if (data.byteLength > CREATOR_LIMITS.maxStoreBytes) {
      throw new CreatorFileError("too_large", "comments.json is larger than the store limit");
    }
    text = data.toString("utf8");
  } finally {
    await handle.close();
  }
  try {
    return decodeStore(JSON.parse(text));
  } catch {
    await moveAside(store);
    return emptyCreatorState();
  }
};

/**
 * Writes `comments.json` atomically: temp file (`O_EXCL`, `O_NOFOLLOW`, 0o600) in the
 * verified project folder, fsync, folder re-verified, then rename. Refuses before
 * touching the disk when the serialized state exceeds 4MB.
 */
export const writeStoreAtomic = async (
  store: ProjectStore,
  state: CreatorStoreFile,
  hooks?: StoreWriteHooks,
): Promise<void> => {
  const data = serializeStore(state);
  if (data.byteLength > CREATOR_LIMITS.maxStoreBytes) {
    throw new CreatorFileError(
      "too_large",
      `comments.json would be ${data.byteLength} bytes; the limit is ${CREATOR_LIMITS.maxStoreBytes}`,
    );
  }

  await verifyJsonDirs(store);
  await hooks?.beforeOpenTemp?.();

  const tempPath = NodePath.join(store.path, `${STORE_FILE}.${NodeCrypto.randomUUID()}.tmp`);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      tempPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
      0o600,
    );
  } catch (cause) {
    if (errno(cause) === "ELOOP") throw unsafe("temp path is a symlink", cause);
    throw cause;
  }

  // The temp file is ours (fresh uuid, O_EXCL). Unlink it through the same path
  // only while the folder still checks out, or right after the post-open check
  // found it swapped (then the file we just made is wherever the path leads).
  let mayUnlink = true;
  let closed = false;
  try {
    try {
      await verifyJsonDirs(store);
    } catch (error) {
      await handle.close();
      closed = true;
      await NodeFSP.unlink(tempPath).catch(() => undefined);
      mayUnlink = false;
      throw error;
    }
    await handle.writeFile(data);
    await handle.sync();
    const tempStats = await handle.stat({ bigint: true });
    if (!tempStats.isFile() || tempStats.dev !== store.dev) {
      throw unsafe("temp file is not on the project folder's device");
    }
    await handle.close();
    closed = true;

    await hooks?.beforeRename?.();
    try {
      await verifyJsonDirs(store);
    } catch (error) {
      mayUnlink = false;
      throw error;
    }
    await NodeFSP.rename(tempPath, NodePath.join(store.path, STORE_FILE));
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    if (mayUnlink) await NodeFSP.unlink(tempPath).catch(() => undefined);
    throw error;
  }
};

const shotFileName = (ref: ShotName): string => {
  if (!COMMENT_ID.test(ref.commentId)) {
    throw new CreatorFileError("invalid_name", "commentId is not a lowercase uuid");
  }
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 1) {
    throw new CreatorFileError("invalid_name", "revision must be a positive safe integer");
  }
  return `${ref.commentId}-r${ref.revision}.png`;
};

/** `<commentId>-r<revision>.png` -> ref, or null when the name is not of that shape. */
export const parseShotFileName = (name: string): ShotName | null => {
  const match = SHOT_FILE.exec(name);
  if (match === null) return null;
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return null;
  return { commentId: match[1] as ShotName["commentId"], revision };
};

const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** Sizes of regular files in the shots folder (anything else counts as 0 bytes). */
const shotsDirectoryBytes = async (store: ProjectStore): Promise<number> => {
  let total = 0;
  for (const name of await NodeFSP.readdir(store.shots.path)) {
    const stats = await NodeFSP.lstat(NodePath.join(store.shots.path, name)).catch(() => null);
    if (stats?.isFile()) total += stats.size;
  }
  return total;
};

/**
 * Writes `shots/<commentId>-r<revision>.png`, never overwriting. If the 50MB total
 * would be exceeded, removes `evictable` shots (in the given order, only as many as
 * needed). Refuses, removing nothing, if evicting all of them would not be enough.
 */
export const writeShot = async (
  store: ProjectStore,
  ref: ShotName,
  png: Uint8Array,
  options: ShotWriteOptions,
): Promise<ShotWriteResult> => {
  const name = shotFileName(ref);
  if (png.byteLength > CREATOR_LIMITS.maxShotBytes) {
    throw new CreatorFileError("too_large", "screenshot is larger than the per-shot limit");
  }
  await verifyShotDirs(store);
  const target = NodePath.join(store.shots.path, name);
  if (
    await NodeFSP.lstat(target).then(
      () => true,
      () => false,
    )
  ) {
    throw new CreatorFileError("exists", `shot already exists: ${name}`);
  }

  // Plan the eviction first so a refusal removes nothing.
  const total = await shotsDirectoryBytes(store);
  const limit = CREATOR_LIMITS.maxShotsTotalBytes;
  const toEvict: Array<{ readonly ref: ShotName; readonly name: string }> = [];
  let projected = total + png.byteLength;
  const seen = new Set<string>([name]);
  for (const candidate of options.evictable) {
    if (projected <= limit) break;
    const candidateName = shotFileName(candidate);
    if (seen.has(candidateName)) continue;
    seen.add(candidateName);
    const stats = await NodeFSP.lstat(NodePath.join(store.shots.path, candidateName)).catch(
      () => null,
    );
    if (stats === null || !stats.isFile()) continue;
    projected -= stats.size;
    toEvict.push({ ref: candidate, name: candidateName });
  }
  if (projected > limit) {
    throw new CreatorFileError(
      "over_budget",
      "screenshots would exceed the project total even after evicting confirmed ones",
    );
  }

  await options.hooks?.beforeOpen?.();
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
      0o600,
    );
  } catch (cause) {
    if (errno(cause) === "EEXIST") {
      throw new CreatorFileError("exists", `shot already exists: ${name}`, { cause });
    }
    if (errno(cause) === "ELOOP") throw unsafe("shot path is a symlink", cause);
    throw cause;
  }

  let mayUnlink = true;
  let closed = false;
  try {
    try {
      await verifyShotDirs(store);
    } catch (error) {
      // Folder swapped after the open: the file we made is wherever the path leads now.
      await handle.close();
      closed = true;
      await NodeFSP.unlink(target).catch(() => undefined);
      mayUnlink = false;
      throw error;
    }
    await handle.writeFile(png);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.dev !== store.shots.dev) {
      throw unsafe("shot file is not on the shots folder's device");
    }
    await handle.close();
    closed = true;

    const evicted: ShotName[] = [];
    try {
      for (const item of toEvict) {
        await verifyShotDirs(store);
        const itemPath = NodePath.join(store.shots.path, item.name);
        const itemStats = await NodeFSP.lstat(itemPath).catch(() => null);
        if (itemStats === null) continue;
        if (!itemStats.isFile()) throw unsafe(`not a regular file: ${item.name}`);
        await NodeFSP.unlink(itemPath);
        evicted.push(item.ref);
      }
    } catch (cause) {
      // The new shot is unlinked below; tell the caller which old ones are already gone.
      throw new CreatorFileError(
        cause instanceof CreatorFileError ? cause.reason : "evict_failed",
        cause instanceof Error ? cause.message : "eviction failed",
        { cause, evicted },
      );
    }
    return { sha256: sha256Hex(png), bytes: png.byteLength, evicted };
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    if (mayUnlink) await NodeFSP.unlink(target).catch(() => undefined);
    throw error;
  }
};

/** Reads a shot (`O_NOFOLLOW`) and returns the bytes only if their sha256 matches `ref.sha256`. */
export const readShot = async (
  store: ProjectStore,
  ref: Pick<CreatorShotRef, "commentId" | "revision" | "sha256">,
): Promise<Buffer> => {
  const name = shotFileName(ref);
  await verifyShotDirs(store);
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      NodePath.join(store.shots.path, name),
      constants.O_RDONLY | O_NOFOLLOW,
    );
  } catch (cause) {
    if (errno(cause) === "ENOENT") {
      throw new CreatorFileError("not_found", `shot not found: ${name}`, { cause });
    }
    if (errno(cause) === "ELOOP") throw unsafe("shot is a symlink", cause);
    throw cause;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw unsafe("shot is not a regular file");
    if (stats.size > CREATOR_LIMITS.maxShotBytes) {
      throw new CreatorFileError("too_large", "shot is larger than the per-shot limit");
    }
    const data = await handle.readFile();
    if (sha256Hex(data) !== ref.sha256) {
      throw new CreatorFileError("hash_mismatch", `shot content does not match its hash: ${name}`);
    }
    return data;
  } finally {
    await handle.close();
  }
};

/**
 * Removes one shot. The entry must be a regular file inside the verified shots
 * folder (a symlink is refused, never followed). Returns false if it was already gone.
 */
export const removeShot = async (store: ProjectStore, ref: ShotName): Promise<boolean> => {
  const name = shotFileName(ref);
  await verifyShotDirs(store);
  const path = NodePath.join(store.shots.path, name);
  const stats = await NodeFSP.lstat(path).catch((cause) => {
    if (errno(cause) === "ENOENT") return null;
    throw cause;
  });
  if (stats === null) return false;
  if (!stats.isFile()) throw unsafe(`not a regular file: ${name}`);
  try {
    await NodeFSP.unlink(path);
  } catch (cause) {
    if (errno(cause) === "ENOENT") return false;
    throw cause;
  }
  return true;
};

/** Names in the shots folder of the strict `<uuid>-r<n>.png` shape, for the orphan sweep. */
export const listShotFiles = async (store: ProjectStore): Promise<ReadonlyArray<string>> => {
  await verifyShotDirs(store);
  return (await NodeFSP.readdir(store.shots.path)).filter(
    (name) => parseShotFileName(name) !== null,
  );
};
