// @effect-diagnostics nodeBuiltinImport:off - temporary folders and symlinks for the link scan.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { scanForOutwardLinks } from "./creatorPaths.ts";

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
