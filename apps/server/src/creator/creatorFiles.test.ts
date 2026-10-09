// @effect-diagnostics nodeBuiltinImport:off - temporary folders and symlinks for the file-safety tests.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { CREATOR_LIMITS, type CreatorShotRef } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { emptyCreatorState } from "./creatorState.ts";
import {
  CreatorFileError,
  listShotFiles,
  parseShotFileName,
  openCreatorRoot,
  openProjectStore,
  readShot,
  readStore,
  removeShot,
  writeShot,
  writeStoreAtomic,
} from "./creatorFiles.ts";

const PID = "0123456789abcdef0123456789abcdef";
const empty = emptyCreatorState();
const MB = 1024 * 1024;
let dirs: string[] = [];
const temp = async () => {
  const d = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-creator-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.map((d) => NodeFSP.rm(d, { recursive: true, force: true })));
  dirs = [];
});

const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const shotRef = (revision = 1, commentId = NodeCrypto.randomUUID()): CreatorShotRef =>
  ({ commentId, revision, sha256: "0".repeat(64), width: 10, height: 10 }) as CreatorShotRef;
const shotFile = (ref: { commentId: string; revision: number }) =>
  `${ref.commentId}-r${ref.revision}.png`;
const newStore = async () => openProjectStore(await openCreatorRoot(await temp()), PID);
/** A sparse file of the given apparent size, placed directly (bypasses writeShot's budget). */
const sparse = async (store: { shots: { path: string } }, ref: CreatorShotRef, size: number) => {
  const file = NodePath.join(store.shots.path, shotFile(ref));
  await NodeFSP.writeFile(file, "");
  await NodeFSP.truncate(file, size);
};

describe("creatorFiles", () => {
  it("round-trips", async () => {
    const store = await newStore();
    await writeStoreAtomic(store, { ...empty, revision: 3 });
    expect((await readStore(store)).revision).toBe(3);
  });

  it("rejects a malformed projectId", async () => {
    await expect(openProjectStore(await openCreatorRoot(await temp()), "../x")).rejects.toThrow();
  });

  it("refuses when creator/ is a symlink", async () => {
    const state = await temp();
    const outside = await temp();
    await NodeFSP.symlink(outside, NodePath.join(state, "creator"));
    await expect(openCreatorRoot(state)).rejects.toThrow();
  });

  it("does not follow comments.json when it is a symlink", async () => {
    const state = await temp();
    const outside = await temp();
    const store = await openProjectStore(await openCreatorRoot(state), PID);
    await NodeFSP.writeFile(NodePath.join(outside, "victim.json"), "keep");
    await NodeFSP.symlink(
      NodePath.join(outside, "victim.json"),
      NodePath.join(store.path, "comments.json"),
    );
    await expect(readStore(store)).rejects.toThrow();
    await writeStoreAtomic(store, empty);
    expect(await NodeFSP.readFile(NodePath.join(outside, "victim.json"), "utf8")).toBe("keep");
  });

  it("detects the project folder swapped for a symlink just before rename", async () => {
    const state = await temp();
    const outside = await temp();
    const store = await openProjectStore(await openCreatorRoot(state), PID);
    const hooks = {
      beforeRename: async () => {
        await NodeFSP.rename(store.path, `${store.path}.moved`);
        await NodeFSP.symlink(outside, store.path);
      },
    };
    // The reason must be the folder check, not an incidental ENOENT from rename.
    await expect(writeStoreAtomic(store, empty, hooks)).rejects.toMatchObject({
      name: "CreatorFileError",
      reason: "unsafe_path",
    });
    expect(await NodeFSP.readdir(outside)).toEqual([]);
    // Our temp is left orphaned in the moved folder; nothing was unlinked through the symlink.
    const moved = await NodeFSP.readdir(`${store.path}.moved`);
    expect(moved.filter((n) => n.endsWith(".tmp"))).toHaveLength(1);
    expect(moved).not.toContain("comments.json");
  });

  it("detects the swap just before the temp file is opened", async () => {
    const state = await temp();
    const outside = await temp();
    const store = await openProjectStore(await openCreatorRoot(state), PID);
    const hooks = {
      beforeOpenTemp: async () => {
        await NodeFSP.rename(store.path, `${store.path}.moved`);
        await NodeFSP.symlink(outside, store.path);
      },
    };
    await expect(writeStoreAtomic(store, empty, hooks)).rejects.toMatchObject({
      reason: "unsafe_path",
    });
    expect(await NodeFSP.readdir(outside)).toEqual([]);
  });

  it("moves a corrupted store aside", async () => {
    const store = await newStore();
    await NodeFSP.writeFile(NodePath.join(store.path, "comments.json"), "{not json");
    expect((await readStore(store)).comments).toEqual([]);
    expect((await NodeFSP.readdir(store.path)).some((n) => n.startsWith("comments.broken-"))).toBe(
      true,
    );
  });

  it("moves a schema-invalid store aside and keeps its bytes", async () => {
    const store = await newStore();
    await NodeFSP.writeFile(NodePath.join(store.path, "comments.json"), '{"version":1}');
    expect(await readStore(store)).toEqual(emptyCreatorState());
    const names = await NodeFSP.readdir(store.path);
    expect(names).not.toContain("comments.json");
    const broken = names.find((n) => /^comments\.broken-.+\.json$/.test(n));
    expect(broken).toBeDefined();
    expect(await NodeFSP.readFile(NodePath.join(store.path, broken!), "utf8")).toBe(
      '{"version":1}',
    );
  });

  it("refuses an oversized store on read without moving it aside", async () => {
    const store = await newStore();
    await NodeFSP.writeFile(
      NodePath.join(store.path, "comments.json"),
      Buffer.alloc(CREATOR_LIMITS.maxStoreBytes + 1, 0x20),
    );
    await expect(readStore(store)).rejects.toThrow();
    const names = await NodeFSP.readdir(store.path);
    expect(names).toContain("comments.json");
    expect(names.some((n) => n.startsWith("comments.broken-"))).toBe(false);
  });

  it("refuses to write more than 4MB, leaving the prior file intact and no temp behind", async () => {
    const store = await newStore();
    await writeStoreAtomic(store, { ...empty, revision: 7 });
    const before = await NodeFSP.readFile(NodePath.join(store.path, "comments.json"), "utf8");
    const huge = {
      ...empty,
      reservations: { big: "x".repeat(CREATOR_LIMITS.maxStoreBytes) },
    } as unknown as typeof empty;
    await expect(writeStoreAtomic(store, huge)).rejects.toThrow();
    expect(await NodeFSP.readFile(NodePath.join(store.path, "comments.json"), "utf8")).toBe(before);
    expect((await NodeFSP.readdir(store.path)).toSorted()).toEqual(["comments.json", "shots"]);
  });

  describe("shots", () => {
    it("writes and reads back a shot, verifying sha256", async () => {
      const store = await newStore();
      const ref = shotRef(2);
      const png = Buffer.from("fake-png-bytes");
      const written = await writeShot(store, ref, png, { evictable: [] });
      expect(written.sha256).toBe(sha(png));
      expect(written.evicted).toEqual([]);
      expect(await NodeFSP.readdir(store.shots.path)).toEqual([shotFile(ref)]);
      const read = await readShot(store, { ...ref, sha256: written.sha256 });
      expect(Buffer.compare(read, png)).toBe(0);
    });

    it("refuses an existing file and leaves its bytes unchanged", async () => {
      const store = await newStore();
      const ref = shotRef(1);
      await writeShot(store, ref, Buffer.from("first"), { evictable: [] });
      await expect(
        writeShot(store, ref, Buffer.from("second"), { evictable: [] }),
      ).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(store.shots.path, shotFile(ref)), "utf8")).toBe(
        "first",
      );
    });

    it("never overwrites through a symlink at the shot name", async () => {
      const store = await newStore();
      const outside = await temp();
      const ref = shotRef(1);
      await NodeFSP.writeFile(NodePath.join(outside, "victim.png"), "keep");
      await NodeFSP.symlink(
        NodePath.join(outside, "victim.png"),
        NodePath.join(store.shots.path, shotFile(ref)),
      );
      await expect(writeShot(store, ref, Buffer.from("x"), { evictable: [] })).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(outside, "victim.png"), "utf8")).toBe("keep");
    });

    it("rejects unsafe names before touching any path", async () => {
      const store = await newStore();
      const png = Buffer.from("x");
      const bad = [
        { commentId: "../../evil", revision: 1 },
        { commentId: NodeCrypto.randomUUID().toUpperCase(), revision: 1 },
        { commentId: NodeCrypto.randomUUID(), revision: -1 },
        { commentId: NodeCrypto.randomUUID(), revision: 0 },
        { commentId: "a".repeat(36), revision: 1 },
        { commentId: "0123456789abcdef0123456789abcdef----", revision: 1 },
        { commentId: NodeCrypto.randomUUID(), revision: 1.5 },
        { commentId: NodeCrypto.randomUUID(), revision: Number.MAX_SAFE_INTEGER + 2 },
      ];
      for (const ref of bad) {
        await expect(
          writeShot(store, ref as CreatorShotRef, png, { evictable: [] }),
        ).rejects.toThrow();
        await expect(
          readShot(store, { ...ref, sha256: sha(png) } as CreatorShotRef),
        ).rejects.toThrow();
        await expect(removeShot(store, ref as CreatorShotRef)).rejects.toThrow();
      }
      expect(await NodeFSP.readdir(store.shots.path)).toEqual([]);
    });

    it("refuses a shot larger than the per-shot limit", async () => {
      const store = await newStore();
      await expect(
        writeShot(store, shotRef(), Buffer.alloc(CREATOR_LIMITS.maxShotBytes + 1), {
          evictable: [],
        }),
      ).rejects.toThrow();
      expect(await NodeFSP.readdir(store.shots.path)).toEqual([]);
    });

    it("evicts the evictable shots oldest first, only as many as needed", async () => {
      const store = await newStore();
      const a = shotRef(1);
      const b = shotRef(1);
      const c = shotRef(1);
      for (const r of [a, b, c]) await sparse(store, r, 17 * MB); // 51MB, already over 50MB
      const png = Buffer.alloc(3 * MB);
      // Caller order is oldest first: b, then a, then c.
      const written = await writeShot(store, shotRef(), png, { evictable: [b, a, c] });
      expect(written.evicted.map((r) => r.commentId)).toEqual([b.commentId]);
      const names = await NodeFSP.readdir(store.shots.path);
      expect(names).toContain(shotFile(a));
      expect(names).toContain(shotFile(c));
      expect(names).not.toContain(shotFile(b));
      expect(names).toHaveLength(3);
    });

    it("reports the already-evicted refs when eviction fails midway", async () => {
      const store = await newStore();
      const outside = await temp();
      const a = shotRef(1);
      const b = shotRef(1);
      await sparse(store, shotRef(1), 46 * MB); // kept; both a and b must go to fit
      await sparse(store, a, 3 * MB);
      await sparse(store, b, 3 * MB);
      const hooks = {
        // After the eviction plan: make b no longer a regular file.
        beforeOpen: async () => {
          const file = NodePath.join(store.shots.path, shotFile(b));
          await NodeFSP.rm(file);
          await NodeFSP.symlink(outside, file);
        },
      };
      const png = Buffer.alloc(3 * MB);
      const newRef = shotRef(1);
      const failure = await writeShot(store, newRef, png, { evictable: [a, b], hooks }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(CreatorFileError);
      expect((failure as CreatorFileError).evicted.map((r) => r.commentId)).toEqual([a.commentId]);
      const names = await NodeFSP.readdir(store.shots.path);
      expect(names).not.toContain(shotFile(a));
      expect(names).not.toContain(shotFile(newRef));
    });

    it("round-trips file names through parseShotFileName and refuses leading zeros", () => {
      const ref = shotRef(12);
      expect(parseShotFileName(shotFile(ref))).toEqual({
        commentId: ref.commentId,
        revision: 12,
      });
      expect(parseShotFileName(`${ref.commentId}-r012.png`)).toBeNull();
      expect(parseShotFileName(`${ref.commentId}-r0.png`)).toBeNull();
    });

    it("refuses, removing nothing, when evicting every evictable shot is not enough", async () => {
      const store = await newStore();
      const keep = shotRef(1);
      const evictable = shotRef(1);
      await sparse(store, keep, 48 * MB);
      await sparse(store, evictable, 2 * MB);
      await expect(
        writeShot(store, shotRef(), Buffer.alloc(3 * MB), { evictable: [evictable] }),
      ).rejects.toThrow();
      const names = (await NodeFSP.readdir(store.shots.path)).toSorted();
      expect(names).toEqual([shotFile(keep), shotFile(evictable)].toSorted());
    });

    it("refuses when over budget and nothing is evictable", async () => {
      const store = await newStore();
      await sparse(store, shotRef(1), 49 * MB);
      await expect(
        writeShot(store, shotRef(), Buffer.alloc(3 * MB), { evictable: [] }),
      ).rejects.toThrow();
      expect(await NodeFSP.readdir(store.shots.path)).toHaveLength(1);
    });

    it("refuses a hash mismatch on read, including a tampered file", async () => {
      const store = await newStore();
      const ref = shotRef(1);
      const written = await writeShot(store, ref, Buffer.from("original"), { evictable: [] });
      await expect(readShot(store, { ...ref, sha256: "f".repeat(64) })).rejects.toThrow();
      await NodeFSP.writeFile(NodePath.join(store.shots.path, shotFile(ref)), "tampered");
      await expect(readShot(store, { ...ref, sha256: written.sha256 })).rejects.toThrow();
    });

    it("does not follow a symlink on read", async () => {
      const store = await newStore();
      const outside = await temp();
      const ref = shotRef(1);
      await NodeFSP.writeFile(NodePath.join(outside, "secret.png"), "secret");
      await NodeFSP.symlink(
        NodePath.join(outside, "secret.png"),
        NodePath.join(store.shots.path, shotFile(ref)),
      );
      await expect(
        readShot(store, { ...ref, sha256: sha(Buffer.from("secret")) }),
      ).rejects.toThrow();
    });

    it("removeShot deletes a regular file and returns false when it is already gone", async () => {
      const store = await newStore();
      const ref = shotRef(1);
      await writeShot(store, ref, Buffer.from("x"), { evictable: [] });
      expect(await removeShot(store, ref)).toBe(true);
      expect(await removeShot(store, ref)).toBe(false);
      expect(await NodeFSP.readdir(store.shots.path)).toEqual([]);
    });

    it("removeShot refuses a symlink and leaves both the link and its target", async () => {
      const store = await newStore();
      const outside = await temp();
      const ref = shotRef(1);
      await NodeFSP.writeFile(NodePath.join(outside, "victim.png"), "keep");
      const link = NodePath.join(store.shots.path, shotFile(ref));
      await NodeFSP.symlink(NodePath.join(outside, "victim.png"), link);
      await expect(removeShot(store, ref)).rejects.toThrow();
      expect((await NodeFSP.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(outside, "victim.png"), "utf8")).toBe("keep");
    });

    it("listShotFiles returns only names of the strict shape", async () => {
      const store = await newStore();
      const ref = shotRef(4);
      await writeShot(store, ref, Buffer.from("x"), { evictable: [] });
      await NodeFSP.writeFile(NodePath.join(store.shots.path, "notes.txt"), "x");
      await NodeFSP.writeFile(
        NodePath.join(store.shots.path, `${NodeCrypto.randomUUID()}-r1.png.tmp`),
        "x",
      );
      await NodeFSP.writeFile(
        NodePath.join(store.shots.path, `${NodeCrypto.randomUUID().toUpperCase()}-r1.png`),
        "x",
      );
      await NodeFSP.writeFile(NodePath.join(store.shots.path, "..png"), "x");
      expect(await listShotFiles(store)).toEqual([shotFile(ref)]);
    });

    it("detects the shots folder swapped for a symlink just before the file is opened", async () => {
      const outside = await temp();
      const store = await newStore();
      const hooks = {
        beforeOpen: async () => {
          await NodeFSP.rename(store.shots.path, `${store.shots.path}.moved`);
          await NodeFSP.symlink(outside, store.shots.path);
        },
      };
      await expect(
        writeShot(store, shotRef(), Buffer.from("x"), { evictable: [], hooks }),
      ).rejects.toThrow();
      expect(await NodeFSP.readdir(outside)).toEqual([]);
    });
  });
});
