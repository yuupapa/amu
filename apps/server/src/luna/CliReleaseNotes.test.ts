// @effect-diagnostics nodeBuiltinImport:off - temporary folders for the cache only.
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  acceptTranslation,
  bulletItems,
  changelogSections,
  cliReleaseNotes,
  compareVersions,
  githubSections,
  hasCliReleaseNotes,
} from "./CliReleaseNotes.ts";

const changelog = `# Changelog

## 2.1.294

- Added **fast** mode for [subagents](https://example.invalid/docs) (#123, #124)
- Fixed a crash

## 2.1.293

- Added Claude Haiku 5.5

## 2.1.292

- Older change
`;

const runtime = { binary: "/fixture-only", home: "", environment: {} };

describe("reading CLI changelogs", () => {
  it("compares plain versions and skips prereleases", () => {
    expect(compareVersions("2.1.294", "2.1.293")).toBeGreaterThan(0);
    expect(compareVersions("0.161.0", "0.161")).toBe(0);
    expect(compareVersions("0.162.0-alpha.18", "0.161.0")).toBeNull();
  });

  it("keeps the versions after the installed one up to the offered one, newest first", () => {
    expect(changelogSections(changelog, "2.1.292", "2.1.294")).toEqual([
      { version: "2.1.294", items: ["Added fast mode for subagents", "Fixed a crash"] },
      { version: "2.1.293", items: ["Added Claude Haiku 5.5"] },
    ]);
    expect(changelogSections(changelog, "2.1.294", "2.1.294")).toEqual([]);
  });

  it("reads GitHub releases with a tag prefix and leaves out prereleases and drafts", () => {
    const releases = [
      { tag_name: "rust-v0.162.0-alpha.1", body: "- alpha", prerelease: true },
      {
        tag_name: "rust-v0.161.0",
        body: "## New Features\n\n- GPT-6.1 Sol is the default (#49318)",
      },
      { tag_name: "rust-v0.160.0", body: "- older" },
      { tag_name: "rust-v0.161.1", body: "- draft", draft: true },
    ];
    expect(githubSections(releases, "rust-v", "0.160.0", "0.161.0")).toEqual([
      { version: "0.161.0", items: ["GPT-6.1 Sol is the default"] },
    ]);
  });

  it("limits the number and length of items", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `- item ${index} ${"x".repeat(400)}`,
    ).join("\n");
    const items = bulletItems(text);
    expect(items).toHaveLength(25);
    expect(items[0]!.length).toBeLessThanOrEqual(300);
  });

  it("knows which CLIs have a readable changelog", () => {
    expect(hasCliReleaseNotes("claudeAgent")).toBe(true);
    expect(hasCliReleaseNotes("codex")).toBe(true);
    expect(hasCliReleaseNotes("cursor")).toBe(false);
  });
});

describe("translating the notes", () => {
  const original = [{ version: "2.1.293", items: ["Added Claude Haiku 5.5", "Fixed a crash"] }];

  it("accepts a translation only when every section and item stays in place", () => {
    const ja = {
      sections: [{ version: "2.1.293", items: ["Claude Haiku 5.5 を追加", "落ちる問題を修正"] }],
    };
    expect(acceptTranslation(ja, original)).toEqual(ja.sections);
    expect(
      acceptTranslation({ sections: [{ version: "2.1.293", items: ["一つだけ"] }] }, original),
    ).toBeNull();
    expect(
      acceptTranslation({ sections: [{ version: "9.9.9", items: ["a", "b"] }] }, original),
    ).toBeNull();
    expect(acceptTranslation({ sections: [] }, original)).toBeNull();
  });

  it("translates with Haiku once and reuses the saved translation", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-cli-notes-"));
    try {
      const haiku = vi.fn(async () => ({
        sections: [
          { version: "2.1.294", items: ["サブエージェントの高速モードを追加", "落ちる問題を修正"] },
          { version: "2.1.293", items: ["Claude Haiku 5.5 を追加"] },
        ],
      }));
      const fetchText = vi.fn(async () => changelog);
      const call = () =>
        cliReleaseNotes({
          driver: "claudeAgent",
          currentVersion: "2.1.292",
          latestVersion: "2.1.294",
          stateDir,
          haikuRuntime: runtime,
          signal: new AbortController().signal,
          fetchText,
          haiku,
        });
      const first = await call();
      expect(first?.language).toBe("ja");
      expect(first?.sections[0]?.items[0]).toBe("サブエージェントの高速モードを追加");
      expect(first?.sourceUrl).toContain("CHANGELOG.md");
      const second = await call();
      expect(second).toEqual(first);
      expect(haiku).toHaveBeenCalledOnce();
      expect(fetchText).toHaveBeenCalledOnce();
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("shows the English original without Claude or when translating fails", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-cli-notes-"));
    try {
      const fetchText = async () => changelog;
      const base = {
        driver: "claudeAgent",
        currentVersion: "2.1.293",
        latestVersion: "2.1.294",
        stateDir,
        signal: new AbortController().signal,
        fetchText,
      };
      const withoutClaude = await cliReleaseNotes({ ...base, haikuRuntime: null });
      expect(withoutClaude).toMatchObject({ language: "en" });
      expect(withoutClaude?.sections[0]?.items).toEqual([
        "Added fast mode for subagents",
        "Fixed a crash",
      ]);
      const failing = await cliReleaseNotes({
        ...base,
        haikuRuntime: runtime,
        haiku: async () => {
          throw new Error("Haikuを利用できません。");
        },
      });
      expect(failing).toMatchObject({ language: "en" });
      // An English fallback is not saved, so the next notice tries to translate again.
      const retried = await cliReleaseNotes({
        ...base,
        haikuRuntime: runtime,
        haiku: async () => ({
          sections: [{ version: "2.1.294", items: ["高速モードを追加", "落ちる問題を修正"] }],
        }),
      });
      expect(retried).toMatchObject({ language: "ja" });
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reads only the GitHub releases in range, one tag at a time", async () => {
    const urls: string[] = [];
    const fetchText = async (url: string) => {
      urls.push(url);
      if (url.includes("matching-refs"))
        return JSON.stringify(
          ["rust-v0.159.0", "rust-v0.160.0", "rust-v0.161.0", "rust-v0.162.0-alpha.1"].map(
            (tag) => ({ ref: `refs/tags/${tag}` }),
          ),
        );
      if (url.endsWith("rust-v0.161.0"))
        return JSON.stringify({ tag_name: "rust-v0.161.0", body: "- New default model" });
      throw new Error("not found");
    };
    const notes = await cliReleaseNotes({
      driver: "codex",
      currentVersion: "0.159.0",
      latestVersion: "0.161.0",
      stateDir: NodeOS.tmpdir(),
      haikuRuntime: null,
      signal: new AbortController().signal,
      fetchText,
    });
    expect(notes?.sections).toEqual([{ version: "0.161.0", items: ["New default model"] }]);
    expect(urls.filter((url) => url.includes("/releases/tags/"))).toHaveLength(2);
    expect(urls.some((url) => url.includes("alpha"))).toBe(false);
  });

  it("has nothing for a CLI without a readable changelog", async () => {
    expect(
      await cliReleaseNotes({
        driver: "cursor",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        stateDir: NodeOS.tmpdir(),
        haikuRuntime: null,
        signal: new AbortController().signal,
        fetchText: async () => "",
      }),
    ).toBeNull();
  });
});
