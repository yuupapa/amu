// @effect-diagnostics nodeBuiltinImport:off - temporary history folders only.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readAmuProjects } from "./WorkFolderRequest.ts";
import {
  claudeCodeFolders,
  codexFolders,
  collectWorkFolders,
  folderChoicesForJudge,
  hintFrom,
  isWorkFolder,
  repositoryNames,
} from "./WorkFolders.ts";

function withTemp(run: (root: string) => void) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.homedir(), ".amu-folders-test-")),
  );
  try {
    run(root);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

const jsonl = (entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

describe("work folders from earlier work", () => {
  it("reads Claude Code's working folder and first request", () =>
    withTemp((root) => {
      const work = NodePath.join(root, "youtube", "showa");
      NodeFS.mkdirSync(work, { recursive: true });
      const project = NodePath.join(root, "claude", "projects", "-encoded");
      NodeFS.mkdirSync(project, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(project, "a.jsonl"),
        jsonl([
          { type: "queue-operation" },
          { type: "user", cwd: work, message: { content: "<command-name>/clear</command-name>" } },
          {
            type: "user",
            cwd: work,
            message: { content: [{ type: "text", text: "No.37の台本を書いて" }] },
          },
        ]),
      );
      const found = claudeCodeFolders(NodePath.join(root, "claude"));
      expect(found).toEqual([
        { path: work, atMs: expect.any(Number), hint: "No.37の台本を書いて" },
      ]);
    }));

  it("reads Codex's session folder and first request, newest days first", () =>
    withTemp((root) => {
      const work = NodePath.join(root, "lp");
      NodeFS.mkdirSync(work);
      for (const [day, text] of [
        ["07", "古い依頼"],
        ["08", "LPの見出しを直して"],
      ] as const) {
        const directory = NodePath.join(root, "codex", "sessions", "2026", "10", day);
        NodeFS.mkdirSync(directory, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(directory, "rollout.jsonl"),
          jsonl([
            { type: "session_meta", payload: { cwd: work } },
            { type: "event_msg", payload: { type: "user_message", message: text } },
          ]),
        );
      }
      expect(codexFolders(NodePath.join(root, "codex"), 1)).toEqual([
        { path: work, atMs: expect.any(Number), hint: "LPの見出しを直して" },
      ]);
    }));

  it("merges sources, keeps the newest first and leaves out non-work folders", () =>
    withTemp((root) => {
      const youtube = NodePath.join(root, "youtube");
      const lp = NodePath.join(root, "lp");
      const amuData = NodePath.join(root, "amu-runtime");
      for (const folder of [youtube, lp, NodePath.join(amuData, "scratch", "x")])
        NodeFS.mkdirSync(folder, { recursive: true });
      const folders = collectWorkFolders({
        amuProjects: [{ path: youtube, titles: ["No.37台本校正と音声作成"], updatedAtMs: 3_000 }],
        found: [
          { path: lp, atMs: 2_000, hint: "LPを直して" },
          { path: youtube, atMs: 1_000, hint: "No.36の台本" },
          { path: NodePath.join(amuData, "scratch", "x"), atMs: 9_000, hint: "scratch" },
          { path: NodePath.join(root, "missing"), atMs: 9_000, hint: "gone" },
          { path: "/tmp", atMs: 9_000, hint: "temporary" },
          { path: NodeOS.homedir(), atMs: 9_000, hint: "home" },
        ],
        excluded: [amuData],
      });
      expect(folders).toEqual([
        {
          id: "f1",
          path: youtube,
          lastUsedMs: 3_000,
          hints: ["No.37台本校正と音声作成", "No.36の台本"],
        },
        { id: "f2", path: lp, lastUsedMs: 2_000, hints: ["LPを直して"] },
      ]);
      const view = folderChoicesForJudge(folders, youtube);
      expect(view.folders[0]).toMatchObject({ id: "f1", isCurrent: true });
      expect(view.folders[0]!.path.startsWith("~/")).toBe(true);
    }));

  it("names the GitHub repositories of a checkout, also from a linked worktree", () =>
    withTemp((root) => {
      const main = NodePath.join(root, "main");
      NodeFS.mkdirSync(NodePath.join(main, ".git", "worktrees", "v2"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(main, ".git", "config"),
        '[remote "origin"]\n\turl = https://github.com/pingdotgg/t3code.git\n[remote "mine"]\n\turl = git@github.com:yuupapa/amu.git\n',
      );
      NodeFS.writeFileSync(NodePath.join(main, ".git", "worktrees", "v2", "commondir"), "../..\n");
      const linked = NodePath.join(root, "v2");
      NodeFS.mkdirSync(linked);
      NodeFS.writeFileSync(
        NodePath.join(linked, ".git"),
        `gitdir: ${NodePath.join(main, ".git", "worktrees", "v2")}\n`,
      );
      expect(repositoryNames(main)).toEqual(["pingdotgg/t3code", "yuupapa/amu"]);
      expect(repositoryNames(linked)).toEqual(["pingdotgg/t3code", "yuupapa/amu"]);
      expect(repositoryNames(root)).toEqual([]);
    }));

  it("leaves out a folder inside another candidate", () =>
    withTemp((root) => {
      const project = NodePath.join(root, "smoke");
      const output = NodePath.join(project, "ep37", "audio");
      NodeFS.mkdirSync(output, { recursive: true });
      const folders = collectWorkFolders({
        amuProjects: [],
        found: [
          { path: output, atMs: 2_000, hint: "音声" },
          { path: project, atMs: 1_000, hint: "台本" },
        ],
        excluded: [],
      });
      expect(folders.map((folder) => folder.path)).toEqual([project]);
    }));

  it("refuses a link into a refused folder", () =>
    withTemp((root) => {
      const amuData = NodePath.join(root, "amu-runtime");
      NodeFS.mkdirSync(NodePath.join(amuData, "scratch"), { recursive: true });
      const link = NodePath.join(root, "looks-normal");
      NodeFS.symlinkSync(NodePath.join(amuData, "scratch"), link);
      const tmpLink = NodePath.join(root, "to-tmp");
      NodeFS.symlinkSync("/tmp", tmpLink);
      expect(isWorkFolder(link, [amuData])).toBe(false);
      expect(isWorkFolder(tmpLink, [])).toBe(false);
      // A plain folder next to them is fine, and the same folder through a link counts once.
      const real = NodePath.join(root, "work");
      NodeFS.mkdirSync(real);
      const alias = NodePath.join(root, "alias");
      NodeFS.symlinkSync(real, alias);
      const folders = collectWorkFolders({
        amuProjects: [],
        found: [
          { path: alias, atMs: 2, hint: "a" },
          { path: real, atMs: 1, hint: "b" },
        ],
        excluded: [amuData],
      });
      expect(folders.map((folder) => folder.path)).toEqual([real]);
    }));

  it("shortens hints and drops system notes", () => {
    expect(hintFrom("a".repeat(100))).toHaveLength(60);
    expect(hintFrom("Caveat: the messages below")).toBeNull();
    expect(hintFrom([{ type: "input_text", text: "  台本を\n直して " }])).toBe("台本を 直して");
    expect(isWorkFolder("relative/path", [])).toBe(false);
  });

  it("keeps only well-formed project entries from the client", () => {
    expect(readAmuProjects(null)).toBeNull();
    expect(
      readAmuProjects({
        current: "relative",
        projects: [
          { path: "/a", titles: ["x".repeat(300), 3], updatedAt: "2026-10-08T00:00:00Z" },
          { path: "not-absolute", titles: [] },
          "junk",
        ],
      }),
    ).toEqual({
      current: null,
      projects: [
        { path: "/a", titles: ["x".repeat(120)], updatedAtMs: Date.parse("2026-10-08T00:00:00Z") },
      ],
    });
  });
});
