// @effect-diagnostics nodeBuiltinImport:off - temporary folders, videos and fake ffprobe runs.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { CreatorFileError, openCreatorRoot } from "./creatorFiles.ts";
import {
  FfprobeError,
  makeReviewProject,
  removeReviewCopy,
  removeStaleReviewCopies,
  runFfprobe,
} from "./reviewProject.ts";

const FAKE = NodePath.join(import.meta.dirname, "fixtures", "fake-ffprobe.mjs");
const PID = "0123456789abcdef0123456789abcdef";

let dirs: string[] = [];
const temp = async () => {
  const d = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-creator-review-")),
  );
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.map((d) => NodeFSP.rm(d, { recursive: true, force: true })));
  dirs = [];
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const setup = async (videoName = "clip.MP4") => {
  const base = await temp();
  const root = await openCreatorRoot(NodePath.join(base, "state"));
  const video = NodePath.join(base, videoName);
  const bytes = NodeCrypto.randomBytes(4096);
  await NodeFSP.writeFile(video, bytes);
  const probed: string[] = [];
  const ffprobe = async (file: string) => {
    probed.push(file);
    return 12.5;
  };
  return { base, root, video, bytes, probed, ffprobe };
};

describe("makeReviewProject", () => {
  it("copies the video and writes a one-video composition with the probed duration", async () => {
    const { root, video, bytes, probed, ffprobe } = await setup();
    const openId = NodeCrypto.randomUUID();
    const project = await makeReviewProject(video, root, { projectId: PID, openId, ffprobe });

    expect(project.servingRoot).toBe(NodePath.join(root.path, "review", PID, openId));
    expect(project.durationSec).toBe(12.5);
    const copy = NodePath.join(project.servingRoot, "video.mp4");
    // The served copy is what gets probed.
    expect(probed).toEqual([copy]);
    const stats = await NodeFSP.lstat(copy);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isFile()).toBe(true);
    expect(Buffer.compare(await NodeFSP.readFile(copy), bytes)).toBe(0);

    const html = await NodeFSP.readFile(NodePath.join(project.servingRoot, "index.html"), "utf8");
    expect(html).toContain('data-composition-id="main" data-no-timeline');
    expect(html).toContain('src="video.mp4"');
    expect(html.match(/data-duration="12.5"/g)).toHaveLength(2);
    expect((await NodeFSP.readdir(project.servingRoot)).toSorted()).toEqual([
      "index.html",
      "video.mp4",
    ]);
  });

  it("makes a fresh folder for every open of the same video", async () => {
    const { root, video, ffprobe } = await setup();
    const a = await makeReviewProject(video, root, {
      projectId: PID,
      openId: NodeCrypto.randomUUID(),
      ffprobe,
    });
    const b = await makeReviewProject(video, root, {
      projectId: PID,
      openId: NodeCrypto.randomUUID(),
      ffprobe,
    });
    expect(a.servingRoot).not.toBe(b.servingRoot);
    expect((await NodeFSP.readdir(NodePath.join(root.path, "review", PID))).length).toBe(2);
  });

  it("refuses an openId folder that already exists and leaves it untouched", async () => {
    const { root, video, ffprobe } = await setup();
    const openId = NodeCrypto.randomUUID();
    const first = await makeReviewProject(video, root, { projectId: PID, openId, ffprobe });
    const before = await NodeFSP.readFile(NodePath.join(first.servingRoot, "index.html"), "utf8");
    await expect(
      makeReviewProject(video, root, { projectId: PID, openId, ffprobe: async () => 99 }),
    ).rejects.toMatchObject({ name: "CreatorFileError", reason: "exists" });
    expect(await NodeFSP.readFile(NodePath.join(first.servingRoot, "index.html"), "utf8")).toBe(
      before,
    );
  });

  it("refuses a video over the size limit before creating anything", async () => {
    const { root, video, ffprobe } = await setup();
    await expect(
      makeReviewProject(video, root, {
        projectId: PID,
        openId: NodeCrypto.randomUUID(),
        ffprobe,
        maxVideoBytes: 4095,
      }),
    ).rejects.toMatchObject({ reason: "too_large" });
    await expect(NodeFSP.lstat(NodePath.join(root.path, "review"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("accepts mov and webm and refuses other extensions", async () => {
    const mov = await setup("take.mov");
    const p = await makeReviewProject(mov.video, mov.root, {
      projectId: PID,
      openId: NodeCrypto.randomUUID(),
      ffprobe: mov.ffprobe,
    });
    expect(await NodeFSP.readdir(p.servingRoot)).toContain("video.mov");
    const avi = await setup("take.avi");
    await expect(
      makeReviewProject(avi.video, avi.root, {
        projectId: PID,
        openId: NodeCrypto.randomUUID(),
        ffprobe: avi.ffprobe,
      }),
    ).rejects.toBeInstanceOf(CreatorFileError);
  });

  it("refuses bad ids and a source that is not a regular file", async () => {
    const { root, video, ffprobe, base } = await setup();
    await expect(
      makeReviewProject(video, root, {
        projectId: "../x",
        openId: NodeCrypto.randomUUID(),
        ffprobe,
      }),
    ).rejects.toMatchObject({ reason: "invalid_name" });
    await expect(
      makeReviewProject(video, root, { projectId: PID, openId: "../../x", ffprobe }),
    ).rejects.toMatchObject({ reason: "invalid_name" });
    const link = NodePath.join(base, "link.mp4");
    await NodeFSP.symlink(video, link);
    await expect(
      makeReviewProject(link, root, { projectId: PID, openId: NodeCrypto.randomUUID(), ffprobe }),
    ).rejects.toMatchObject({ reason: "unsafe_path" });
  });

  it("refuses a source swapped for a symlink right before the copy", async () => {
    const { base, root, video, ffprobe } = await setup("clip.mp4");
    const secret = NodePath.join(base, "secret.mp4");
    await NodeFSP.writeFile(secret, "secret bytes");
    const openId = NodeCrypto.randomUUID();
    const refused = await makeReviewProject(video, root, {
      projectId: PID,
      openId,
      ffprobe,
      beforeCopy: async () => {
        await NodeFSP.rm(video);
        await NodeFSP.symlink(secret, video);
      },
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CreatorFileError);
    expect((refused as CreatorFileError).reason).toBe("unsafe_path");
    expect(await NodeFSP.readdir(NodePath.join(root.path, "review", PID))).toEqual([]);
  });

  it("refuses a source replaced by another file right before the copy", async () => {
    const { root, video, ffprobe } = await setup("clip.mp4");
    const openId = NodeCrypto.randomUUID();
    const refused = await makeReviewProject(video, root, {
      projectId: PID,
      openId,
      ffprobe,
      beforeCopy: async () => {
        await NodeFSP.rm(video);
        await NodeFSP.writeFile(video, "a different file");
      },
    }).catch((error: unknown) => error);
    expect((refused as CreatorFileError).reason).toBe("unsafe_path");
    expect(await NodeFSP.readdir(NodePath.join(root.path, "review", PID))).toEqual([]);
  });

  it("removes the half-made folder when ffprobe fails", async () => {
    const { root, video } = await setup();
    const openId = NodeCrypto.randomUUID();
    await expect(
      makeReviewProject(video, root, {
        projectId: PID,
        openId,
        ffprobe: async () => {
          throw new FfprobeError("failed", "boom");
        },
      }),
    ).rejects.toMatchObject({ reason: "failed" });
    await expect(
      NodeFSP.lstat(NodePath.join(root.path, "review", PID, openId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a review folder replaced by a symlink and writes nothing through it", async () => {
    const { root, video, ffprobe, base } = await setup();
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.symlink(outside, NodePath.join(root.path, "review"));
    await expect(
      makeReviewProject(video, root, { projectId: PID, openId: NodeCrypto.randomUUID(), ffprobe }),
    ).rejects.toMatchObject({ reason: "unsafe_path" });
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });
});

describe("removeReviewCopy", () => {
  it("removes one open's folder and reports whether it was there", async () => {
    const { root, video, ffprobe } = await setup();
    const keep = await makeReviewProject(video, root, {
      projectId: PID,
      openId: NodeCrypto.randomUUID(),
      ffprobe,
    });
    const openId = NodeCrypto.randomUUID();
    const drop = await makeReviewProject(video, root, { projectId: PID, openId, ffprobe });
    expect(await removeReviewCopy(root, PID, openId)).toBe(true);
    await expect(NodeFSP.lstat(drop.servingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await NodeFSP.lstat(keep.servingRoot)).isDirectory()).toBe(true);
    expect(await removeReviewCopy(root, PID, openId)).toBe(false);
    await expect(removeReviewCopy(root, PID, "..")).rejects.toMatchObject({
      reason: "invalid_name",
    });
  });

  it("does not follow a symlink in place of the copy", async () => {
    const { root, base } = await setup();
    const outside = NodePath.join(base, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.writeFile(NodePath.join(outside, "keep.txt"), "x");
    await NodeFSP.mkdir(NodePath.join(root.path, "review", PID), { recursive: true });
    const openId = NodeCrypto.randomUUID();
    await NodeFSP.symlink(outside, NodePath.join(root.path, "review", PID, openId));
    await expect(removeReviewCopy(root, PID, openId)).rejects.toMatchObject({
      reason: "unsafe_path",
    });
    expect(await NodeFSP.readdir(outside)).toEqual(["keep.txt"]);
  });
});

describe("runFfprobe", () => {
  const fake = async (
    mode: string,
    options: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ) => {
    const base = await temp();
    const pidFile = NodePath.join(base, "pid");
    const result = runFfprobe(NodePath.join(base, "v.mp4"), {
      command: process.execPath,
      argsPrefix: [FAKE, mode, pidFile],
      ...options,
    });
    return { result, pidFile };
  };
  const pidOf = async (pidFile: string) => Number(await NodeFSP.readFile(pidFile, "utf8"));

  it("returns the duration in seconds", async () => {
    const { result } = await fake("ok");
    expect(await result).toBe(12.5);
  });

  it("limits ffprobe to local files and video containers", async () => {
    const { result, pidFile } = await fake("ok");
    await result;
    const args = (await NodeFSP.readFile(`${pidFile}.args`, "utf8")).split("\n");
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-protocol_whitelist")).toBe("file");
    expect(at("-format_whitelist")).toBe("mov,mp4,matroska,webm");
    expect(args.at(-1)).toBe(NodePath.join(NodePath.dirname(pidFile), "v.mp4"));
  });

  it("refuses a relative path without running ffprobe", async () => {
    const pidFile = NodePath.join(await temp(), "pid");
    await expect(
      runFfprobe("v.mp4", { command: process.execPath, argsPrefix: [FAKE, "ok", pidFile] }),
    ).rejects.toMatchObject({ name: "FfprobeError", reason: "failed" });
    await expect(NodeFSP.lstat(pidFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a duration of zero or over 6 hours as unreadable", async () => {
    await expect((await fake("zero")).result).rejects.toMatchObject({ reason: "bad_output" });
    await expect((await fake("long")).result).rejects.toMatchObject({ reason: "bad_output" });
  });

  it("gives up after the time limit and kills the child", async () => {
    const { result, pidFile } = await fake("slow", { timeoutMs: 300 });
    await expect(result).rejects.toMatchObject({ name: "FfprobeError", reason: "timeout" });
    expect(isAlive(await pidOf(pidFile))).toBe(false);
  });

  it("gives up when the output passes the cap and kills the child", async () => {
    const { result, pidFile } = await fake("flood", { maxOutputBytes: 64 * 1024 });
    await expect(result).rejects.toMatchObject({ reason: "overflow" });
    expect(isAlive(await pidOf(pidFile))).toBe(false);
  });

  it("fails on a non-zero exit and on output it cannot read", async () => {
    await expect((await fake("fail")).result).rejects.toMatchObject({ reason: "failed" });
    await expect((await fake("garbage")).result).rejects.toMatchObject({ reason: "bad_output" });
  });
});

describe("removeStaleReviewCopies", () => {
  it("refuses links at every directory level without touching their targets", async () => {
    const openId = "11111111-1111-4111-8111-111111111111";
    for (const level of ["creator", "review", "project", "copy"]) {
      const { base, root } = await setup();
      const outside = NodePath.join(base, "outside");
      await NodeFSP.mkdir(outside);
      const sentinel = NodePath.join(outside, "sentinel");
      await NodeFSP.writeFile(sentinel, "keep");
      const path =
        level === "creator"
          ? root.path
          : level === "review"
            ? NodePath.join(root.path, "review")
            : level === "project"
              ? NodePath.join(root.path, "review", PID)
              : NodePath.join(root.path, "review", PID, openId);
      if (level === "creator") await NodeFSP.rm(path, { recursive: true });
      else await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
      await NodeFSP.symlink(outside, path);
      await expect(removeStaleReviewCopies(NodePath.dirname(root.path))).rejects.toMatchObject({
        reason: "unsafe_path",
      });
      expect((await NodeFSP.lstat(path)).isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readFile(sentinel, "utf8")).toBe("keep");
    }
  });

  it("does not create a Creator root in a state directory without review copies", async () => {
    const base = await temp();
    await removeStaleReviewCopies(base);
    expect(await NodeFSP.readdir(base)).toEqual([]);
  });
});
