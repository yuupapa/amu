// @effect-diagnostics nodeBuiltinImport:off - reads the server source to find stale reasons.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { CLEANUP_REASONS_JA, translateCleanupReason } from "./storageCleanupReason";

describe("translateCleanupReason", () => {
  it("translates reasons, keeping inserted values", () => {
    expect(translateCleanupReason("No rules apply")).toBe("当てはまる整理のルールがありません");
    expect(translateCleanupReason("Has ignored files (.env)")).toBe(
      "Git が無視するファイルがあります（.env）",
    );
    expect(translateCleanupReason("Has uncommitted changes (1 file)")).toBe(
      "コミットしていない変更があります（1 ファイル）",
    );
    expect(translateCleanupReason("Inactive for 3 of 7 days")).toBe(
      "3 日使われていません（7 日で削除）",
    );
    expect(translateCleanupReason("Inactive for 9 days")).toBe("9 日使われていませんでした");
    expect(translateCleanupReason("Open terminal")).toBe("ターミナルが開いています");
  });

  it("leaves Git errors as the server wrote them", () => {
    expect(translateCleanupReason("git worktree remove: fatal: not a git repository")).toBe(
      "git worktree remove: fatal: not a git repository",
    );
  });

  // The server may reword a reason; a reason no longer produced would silently show English.
  it("only lists reasons the server still produces", () => {
    const source = NodeFS.readFileSync(
      new URL("../../../server/src/storageCleanup.ts", import.meta.url),
      "utf8",
    );
    const stale = Object.keys(CLEANUP_REASONS_JA).filter((reason) => {
      const prefix = reason.split("{")[0]!;
      const lowered = prefix.charAt(0).toLowerCase() + prefix.slice(1);
      return !source.includes(prefix) && !source.includes(lowered);
    });
    expect(stale).toEqual([]);
  });
});
