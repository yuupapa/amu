// @effect-diagnostics nodeBuiltinImport:off - a temporary state folder only.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isThreadFolderId,
  readThreadFolderState,
  readThreadFolders,
  setThreadFolder,
} from "./ThreadFolders.ts";

describe("threads listed under another project", () => {
  it("saves, changes and clears a thread's listed project", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-thread-folders-"));
    try {
      expect(readThreadFolders(stateDir)).toEqual({});
      setThreadFolder(stateDir, "thread-a", "project-youtube");
      setThreadFolder(stateDir, "thread-b", "project-lp");
      expect(readThreadFolders(stateDir)).toEqual({
        "thread-a": "project-youtube",
        "thread-b": "project-lp",
      });
      expect(setThreadFolder(stateDir, "thread-a", null)).toEqual({
        entries: { "thread-b": "project-lp" },
        revision: 3,
      });
      expect(readThreadFolderState(stateDir).revision).toBe(3);
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("ignores a broken file and entries of the wrong shape", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-thread-folders-"));
    try {
      NodeFS.writeFileSync(NodePath.join(stateDir, "thread-folders.json"), "{ broken");
      expect(readThreadFolders(stateDir)).toEqual({});
      NodeFS.writeFileSync(
        NodePath.join(stateDir, "thread-folders.json"),
        JSON.stringify({ version: 1, entries: { ok: "p1", "bad id with spaces": "p2", other: 3 } }),
      );
      expect(readThreadFolders(stateDir)).toEqual({ ok: "p1" });
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("accepts the thread ids Amu uses, and nothing with spaces or slashes", () => {
    expect(isThreadFolderId("thread:provider:claudeAgent:native-thread:a%3Ab")).toBe(true);
    expect(isThreadFolderId("7859c9bb-c32c-4fe6-8a57-fcb8c2fbd6fa")).toBe(true);
    expect(isThreadFolderId("../etc")).toBe(false);
    expect(isThreadFolderId("a b")).toBe(false);
    expect(isThreadFolderId("")).toBe(false);
  });
});
