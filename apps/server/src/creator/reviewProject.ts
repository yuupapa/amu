// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - COPYFILE_EXCL, lstat checks and a bounded ffprobe child (plain async, like creatorFiles.ts).
/**
 * The review project Amu Creator serves when the user opens a video file.
 *
 * Each open gets its own folder `<stateDir>/creator/review/<projectId>/<openId>/`
 * holding a copy of the video (never a link: the link scan would refuse it, and a
 * link would let the preview serve whatever it points at) and an `index.html`
 * with one video clip. A folder that is being served is never rebuilt; the next
 * open makes a new one, and `removeReviewCopy` deletes an old one once its
 * binding and preview have stopped. Directory handling follows `creatorFiles.ts`
 * (lstat-checked levels, no symlinks, exclusive creates).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CreatorFileError,
  ensureDir,
  verifyDir,
  type CreatorRoot,
  type DirStamp,
} from "./creatorFiles.ts";

const PROJECT_ID = /^[a-f0-9]{32}$/;
const OPEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "mov", "webm"]);

export const REVIEW_LIMITS = {
  maxVideoBytes: 4 * 1024 ** 3,
  ffprobeTimeoutMs: 10_000,
  ffprobeMaxOutputBytes: 64 * 1024,
  /** A probed duration above this (6 hours) is treated as unreadable. */
  maxDurationSec: 6 * 60 * 60,
} as const;

const isUsableDuration = (seconds: number) =>
  Number.isFinite(seconds) && seconds > 0 && seconds <= REVIEW_LIMITS.maxDurationSec;

export type FfprobeFailure = "timeout" | "overflow" | "failed" | "bad_output";

export class FfprobeError extends Error {
  readonly reason: FfprobeFailure;
  constructor(reason: FfprobeFailure, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "FfprobeError";
    this.reason = reason;
  }
}

export interface FfprobeOptions {
  /** Defaults to `ffprobe` from PATH. */
  readonly command?: string;
  /** Arguments placed before the ffprobe arguments (tests run a fake through node). */
  readonly argsPrefix?: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

const errno = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;

/**
 * The container duration in seconds. Killed and failed after `timeoutMs` (10 s)
 * or once stdout passes `maxOutputBytes` (64KB); settles only after the child
 * has exited.
 */
export const runFfprobe = (file: string, options: FfprobeOptions = {}): Promise<number> =>
  new Promise((resolve, reject) => {
    if (!NodePath.isAbsolute(file)) {
      reject(new FfprobeError("failed", "ffprobe needs an absolute path"));
      return;
    }
    const timeoutMs = options.timeoutMs ?? REVIEW_LIMITS.ffprobeTimeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? REVIEW_LIMITS.ffprobeMaxOutputBytes;
    const child = NodeChildProcess.spawn(
      options.command ?? "ffprobe",
      [
        ...(options.argsPrefix ?? []),
        "-v",
        "error",
        // Local files only, and only the demuxers for the accepted extensions, so
        // a playlist or concat file cannot make ffprobe open other inputs.
        "-protocol_whitelist",
        "file",
        "-format_whitelist",
        "mov,mp4,matroska,webm",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      { stdio: ["ignore", "pipe", "ignore"], shell: false },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: FfprobeError | null = null;
    let settled = false;
    const abort = (error: FfprobeError) => {
      if (failure !== null) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => abort(new FfprobeError("timeout", `ffprobe took longer than ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        abort(new FfprobeError("overflow", `ffprobe wrote more than ${maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new FfprobeError("failed", `ffprobe could not run: ${cause.message}`, { cause }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (failure !== null) return reject(failure);
      if (code !== 0) return reject(new FfprobeError("failed", `ffprobe exited with ${code}`));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          format?: { duration?: unknown };
        };
        const duration = Number(parsed.format?.duration);
        if (isUsableDuration(duration)) return resolve(duration);
      } catch {
        // falls through to bad_output
      }
      reject(new FfprobeError("bad_output", "ffprobe did not report a duration"));
    });
  });

export interface ReviewProjectOptions {
  readonly projectId: string;
  readonly openId: string;
  /** Duration in seconds of the given file; `runFfprobe` in production. */
  readonly ffprobe: (file: string) => Promise<number>;
  readonly maxVideoBytes?: number;
}

export interface ReviewProject {
  /** `<creator>/review/<projectId>/<openId>`, the folder to preview. */
  readonly servingRoot: string;
  /** `video.<ext>` inside `servingRoot`. */
  readonly videoFile: string;
  readonly durationSec: number;
}

const checkIds = (projectId: string, openId: string) => {
  if (!PROJECT_ID.test(projectId)) {
    throw new CreatorFileError("invalid_name", "projectId must be 32 lowercase hex characters");
  }
  if (!OPEN_ID.test(openId)) {
    throw new CreatorFileError("invalid_name", "openId must be a lowercase UUID");
  }
};

const verifyAll = async (dirs: ReadonlyArray<DirStamp>) => {
  for (const dir of dirs) await verifyDir(dir);
};

const formatSeconds = (seconds: number) => String(Number(seconds.toFixed(3)));

/** One video filling a 1920x1080 frame for the whole composition. No GSAP timeline (`data-no-timeline`), so nothing is fetched from a CDN; `hyperframes lint` passes with 0 errors and 0 warnings. */
export const reviewCompositionHtml = (videoFile: string, durationSec: number): string => {
  const duration = formatSeconds(durationSec);
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>Amu Creator</title>
    <style>
      body { margin: 0; background: #000; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #000; }
      #video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-no-timeline data-start="0" data-duration="${duration}" data-width="1920" data-height="1080">
      <video id="video" class="clip" src="${videoFile}" data-start="0" data-duration="${duration}" data-track-index="0" data-has-audio="true" playsinline></video>
    </div>
  </body>
</html>
`;
};

/**
 * Makes `review/<projectId>/<openId>/` (refused if it exists), copies the video
 * in as `video.<ext>`, probes the copy and writes `index.html`. Anything left
 * half-made is removed when a step fails.
 */
export const makeReviewProject = async (
  videoRealPath: string,
  root: CreatorRoot,
  options: ReviewProjectOptions,
): Promise<ReviewProject> => {
  const { projectId, openId } = options;
  checkIds(projectId, openId);
  const maxVideoBytes = options.maxVideoBytes ?? REVIEW_LIMITS.maxVideoBytes;
  const ext = NodePath.extname(videoRealPath).slice(1).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    throw new CreatorFileError("invalid_name", "Only mp4, mov and webm videos can be reviewed");
  }
  let source: NodeFS.Stats;
  try {
    source = await NodeFSP.lstat(videoRealPath);
  } catch (cause) {
    throw new CreatorFileError("not_found", `Video not found: ${videoRealPath}`, { cause });
  }
  if (source.isSymbolicLink() || !source.isFile()) {
    throw new CreatorFileError("unsafe_path", "The video must be a regular file (resolved path)");
  }
  if (source.size > maxVideoBytes) {
    throw new CreatorFileError("too_large", `Videos over ${maxVideoBytes} bytes are refused`);
  }

  await verifyDir(root);
  const review = await ensureDir(NodePath.join(root.path, "review"));
  const project = await ensureDir(NodePath.join(review.path, projectId));
  const servingRoot = NodePath.join(project.path, openId);
  await verifyAll([root, review, project]);
  try {
    await NodeFSP.mkdir(servingRoot, { mode: 0o700 });
  } catch (cause) {
    if (errno(cause) === "EEXIST") {
      throw new CreatorFileError("exists", `Review folder already exists: ${servingRoot}`);
    }
    throw cause;
  }
  const created = await NodeFSP.lstat(servingRoot, { bigint: true });
  const dirs = [
    root,
    review,
    project,
    { path: servingRoot, dev: created.dev, ino: created.ino },
  ] as const;

  try {
    await verifyAll(dirs);
    const videoFile = `video.${ext}`;
    const copy = NodePath.join(servingRoot, videoFile);
    await NodeFSP.copyFile(videoRealPath, copy, NodeFS.constants.COPYFILE_EXCL);
    const copied = await NodeFSP.lstat(copy);
    if (!copied.isFile()) throw new CreatorFileError("unsafe_path", "The copy is not a file");
    if (copied.size > maxVideoBytes) {
      throw new CreatorFileError("too_large", `Videos over ${maxVideoBytes} bytes are refused`);
    }
    const durationSec = await options.ffprobe(copy);
    if (!isUsableDuration(durationSec)) {
      throw new FfprobeError("bad_output", "ffprobe did not report a duration");
    }
    await verifyAll(dirs);
    await NodeFSP.writeFile(
      NodePath.join(servingRoot, "index.html"),
      reviewCompositionHtml(videoFile, durationSec),
      { flag: "wx", mode: 0o600 },
    );
    return { servingRoot, videoFile, durationSec };
  } catch (error) {
    // Only through a path that still verifies, so a swapped folder is never followed.
    try {
      await verifyAll(dirs);
      await NodeFSP.rm(servingRoot, { recursive: true, force: true });
    } catch {
      // Leave it; a later removeReviewCopy or cleanup can take it.
    }
    throw error;
  }
};

/** lstat that requires a plain directory; `null` when absent. */
const plainDir = async (path: string): Promise<boolean> => {
  let stats: NodeFS.Stats;
  try {
    stats = await NodeFSP.lstat(path);
  } catch (cause) {
    if (errno(cause) === "ENOENT") return false;
    throw cause;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CreatorFileError("unsafe_path", `Review path is not a plain directory: ${path}`);
  }
  return true;
};

/**
 * Deletes one open's copy. Call only after its binding and its preview have
 * stopped. `false` when it was already gone. Never follows a symlink.
 */
export const removeReviewCopy = async (
  root: CreatorRoot,
  projectId: string,
  openId: string,
): Promise<boolean> => {
  checkIds(projectId, openId);
  await verifyDir(root);
  const review = NodePath.join(root.path, "review");
  const project = NodePath.join(review, projectId);
  const servingRoot = NodePath.join(project, openId);
  for (const dir of [review, project, servingRoot]) {
    if (!(await plainDir(dir))) return false;
  }
  // `rm` removes links inside the folder without following them.
  await NodeFSP.rm(servingRoot, { recursive: true });
  return true;
};
