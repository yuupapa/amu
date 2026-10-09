// @effect-diagnostics nodeBuiltinImport:off - temporary folders and symlinks for the link scan.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { isInsideRealRoot, realPathInside, scanForOutwardLinks } from "./creatorPaths.ts";

let dirs: string[] = [];
const temp = async () => {
  const d = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-creator-paths-")),
  );
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(dirs.map((d) => NodeFSP.rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** `<base>/project` with an index.html, plus `<base>/state/comments.json` outside it. */
const fixture = async () => {
  const base = await temp();
  const root = NodePath.join(base, "project");
  await NodeFSP.mkdir(NodePath.join(root, "assets"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "index.html"), "<html></html>");
  await NodeFSP.mkdir(NodePath.join(base, "state"));
  const secret = NodePath.join(base, "state", "comments.json");
  await NodeFSP.writeFile(secret, "{}");
  return { base, root, secret };
};

describe("scanForOutwardLinks", () => {
  it("allows a project without links", async () => {
    const { root } = await fixture();
    expect(await scanForOutwardLinks(root)).toEqual({ ok: true });
  });

  it("refuses a link whose target is outside the root", async () => {
    const { root, secret } = await fixture();
    await NodeFSP.symlink(secret, NodePath.join(root, "assets", "leak.json"));
    expect(await scanForOutwardLinks(root)).toEqual({
      ok: false,
      reason: "outward_link",
      path: NodePath.join(root, "assets", "leak.json"),
    });
  });

  it("refuses a relative link that climbs out of the root", async () => {
    const { root } = await fixture();
    await NodeFSP.symlink("../state", NodePath.join(root, "up"));
    expect(await scanForOutwardLinks(root)).toMatchObject({ ok: false, reason: "outward_link" });
  });

  it("refuses an outward link inside node_modules", async () => {
    const { root, secret } = await fixture();
    await NodeFSP.mkdir(NodePath.join(root, "node_modules", "pkg"), { recursive: true });
    await NodeFSP.symlink(secret, NodePath.join(root, "node_modules", "pkg", "x.json"));
    expect(await scanForOutwardLinks(root)).toMatchObject({ ok: false, reason: "outward_link" });
  });

  it("allows links to files and folders inside the root", async () => {
    const { root } = await fixture();
    await NodeFSP.symlink(NodePath.join(root, "index.html"), NodePath.join(root, "copy.html"));
    await NodeFSP.symlink("assets", NodePath.join(root, "media"));
    expect(await scanForOutwardLinks(root)).toEqual({ ok: true });
  });

  it("allows a dangling link only when its target text stays inside the root", async () => {
    const { root, base } = await fixture();
    await NodeFSP.symlink("assets/missing.png", NodePath.join(root, "later.png"));
    expect(await scanForOutwardLinks(root)).toEqual({ ok: true });
    await NodeFSP.symlink(NodePath.join(base, "state", "gone.json"), NodePath.join(root, "x"));
    expect(await scanForOutwardLinks(root)).toMatchObject({ ok: false, reason: "outward_link" });
  });

  it("refuses a dangling link whose `..` climbs out through an in-root link", async () => {
    const { root } = await fixture();
    // `self` points at the root (inside). Read lexically, `self/../escape.json` is
    // `<root>/escape.json`; resolved for real it is `<base>/escape.json`.
    await NodeFSP.symlink(".", NodePath.join(root, "self"));
    await NodeFSP.symlink("self/../escape.json", NodePath.join(root, "x"));
    expect(await scanForOutwardLinks(root)).toEqual({
      ok: false,
      reason: "outward_link",
      path: NodePath.join(root, "x"),
    });
  });

  it("allows a dangling link through plain in-root folders, even with `..`", async () => {
    const { root } = await fixture();
    await NodeFSP.symlink("assets/../assets/new/later.png", NodePath.join(root, "later.png"));
    expect(await scanForOutwardLinks(root)).toEqual({ ok: true });
  });

  it("refuses a link it cannot resolve for a reason other than a missing target", async () => {
    const { root } = await fixture();
    const locked = NodePath.join(root, "assets");
    await NodeFSP.writeFile(NodePath.join(locked, "a.png"), "");
    await NodeFSP.symlink("assets/a.png", NodePath.join(root, "a.png"));
    await NodeFSP.chmod(locked, 0o000);
    try {
      // realpath fails with EACCES, not ENOENT.
      expect(await scanForOutwardLinks(root)).toMatchObject({
        ok: false,
        path: NodePath.join(root, "a.png"),
      });
    } finally {
      await NodeFSP.chmod(locked, 0o700);
    }
  });

  it("refuses a link that loops", async () => {
    const { root } = await fixture();
    await NodeFSP.symlink("loop", NodePath.join(root, "loop"));
    expect(await scanForOutwardLinks(root)).toMatchObject({ ok: false });
  });

  it("does not follow a link into the folder it points at", async () => {
    const { root, base } = await fixture();
    // A link inside the root to a folder inside the root that itself holds an outward link.
    await NodeFSP.symlink(NodePath.join(base, "state"), NodePath.join(root, "assets", "out"));
    await NodeFSP.symlink("assets", NodePath.join(root, "alias"));
    expect(await scanForOutwardLinks(root)).toEqual({
      ok: false,
      reason: "outward_link",
      path: NodePath.join(root, "assets", "out"),
    });
  });

  it("refuses when the entry count is over the cap", async () => {
    const { root } = await fixture();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        NodeFSP.writeFile(NodePath.join(root, "assets", `f${i}.txt`), ""),
      ),
    );
    expect(await scanForOutwardLinks(root, { maxEntries: 10 })).toEqual({
      ok: false,
      reason: "too_many_entries",
    });
    expect(await scanForOutwardLinks(root, { maxEntries: 100 })).toEqual({ ok: true });
  });

  it("refuses when the scan runs past its time limit", async () => {
    const { root } = await fixture();
    expect(await scanForOutwardLinks(root, { timeoutMs: 0 })).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("refuses a folder it cannot read", async () => {
    const { root } = await fixture();
    const locked = NodePath.join(root, "assets");
    await NodeFSP.chmod(locked, 0o000);
    try {
      expect(await scanForOutwardLinks(root)).toEqual({
        ok: false,
        reason: "unreadable",
        path: locked,
      });
    } finally {
      await NodeFSP.chmod(locked, 0o700);
    }
  });

  it("refuses a root that is not a directory", async () => {
    const { root } = await fixture();
    expect(await scanForOutwardLinks(NodePath.join(root, "index.html"))).toEqual({
      ok: false,
      reason: "not_directory",
    });
  });
});

describe("isInsideRealRoot", () => {
  /** `<base>/work` (the workspace) with `project/`, plus `<base>/outside/` next to it. */
  const workspace = async () => {
    const base = await temp();
    const work = NodePath.join(base, "work");
    await NodeFSP.mkdir(NodePath.join(work, "project"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(base, "outside"));
    return { base, work };
  };

  it("allows a folder inside the workspace, by relative or absolute path", async () => {
    const { work } = await workspace();
    expect(await isInsideRealRoot(work, "project")).toBe(true);
    expect(await isInsideRealRoot(work, NodePath.join(work, "project"))).toBe(true);
    expect(await realPathInside(work, "project")).toBe(NodePath.join(work, "project"));
  });

  it("allows the workspace itself", async () => {
    const { work } = await workspace();
    expect(await isInsideRealRoot(work, ".")).toBe(true);
    expect(await isInsideRealRoot(work, work)).toBe(true);
  });

  it("refuses an absolute path outside the workspace", async () => {
    const { base, work } = await workspace();
    expect(await isInsideRealRoot(work, NodePath.join(base, "outside"))).toBe(false);
    expect(await isInsideRealRoot(work, "/")).toBe(false);
  });

  it("refuses a relative path that climbs out", async () => {
    const { work } = await workspace();
    expect(await isInsideRealRoot(work, "project/../../outside")).toBe(false);
    expect(await isInsideRealRoot(work, "..")).toBe(false);
  });

  it("refuses a sibling whose name only starts with the workspace's", async () => {
    const { base, work } = await workspace();
    await NodeFSP.mkdir(NodePath.join(base, "work-evil"));
    expect(await isInsideRealRoot(work, NodePath.join(base, "work-evil"))).toBe(false);
    expect(await isInsideRealRoot(work, "../work-evil")).toBe(false);
  });

  it("refuses a link inside the workspace that points outside", async () => {
    const { base, work } = await workspace();
    await NodeFSP.symlink(NodePath.join(base, "outside"), NodePath.join(work, "escape"));
    expect(await isInsideRealRoot(work, "escape")).toBe(false);
    expect(await isInsideRealRoot(work, NodePath.join(work, "escape"))).toBe(false);
  });

  it("compares real paths when the workspace itself is reached through a link", async () => {
    const { base, work } = await workspace();
    const alias = NodePath.join(base, "alias");
    await NodeFSP.symlink(work, alias);
    expect(await isInsideRealRoot(alias, NodePath.join(work, "project"))).toBe(true);
    expect(await isInsideRealRoot(work, NodePath.join(alias, "project"))).toBe(true);
    expect(await realPathInside(alias, "project")).toBe(NodePath.join(work, "project"));
    expect(await isInsideRealRoot(alias, NodePath.join(base, "outside"))).toBe(false);
  });

  it("refuses a path that does not exist", async () => {
    const { work } = await workspace();
    expect(await isInsideRealRoot(work, "missing")).toBe(false);
    expect(await isInsideRealRoot(NodePath.join(work, "missing"), ".")).toBe(false);
  });
});
