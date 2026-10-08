import { describe, expect, it } from "vite-plus/test";

import { buildAmuProjectGroups, groupDisplayName, groupFolderFor } from "./projectGroups";

const home = "/Users/yui";
const project = (projectKey: string, workspaceRoot: string) => ({
  projectKey,
  displayName: projectKey,
  workspaceRoot,
});

describe("project groups", () => {
  it("names a group after the parent folder, past date and generic folders", () => {
    expect(groupFolderFor(`${home}/Documents/Codex/2026-10-01/task/smoke-project`, home)).toBe(
      `${home}/Documents/Codex`,
    );
    expect(groupFolderFor(`${home}/YouTube/showa`, home)).toBe(`${home}/YouTube`);
    expect(
      groupFolderFor(
        `${home}/Library/CloudStorage/GoogleDrive-team@example.com/共有ドライブ/台本`,
        home,
      ),
    ).toBe(`${home}/Library/CloudStorage/GoogleDrive-team@example.com`);
    expect(groupDisplayName(`${home}/Library/CloudStorage/GoogleDrive-team@example.com`)).toBe(
      "Google Drive team@example.com",
    );
    // Right in the home folder or the Documents folder: no group.
    expect(groupFolderFor(`${home}/notes`, home)).toBeNull();
    expect(groupFolderFor(`${home}/Documents/notes`, home)).toBeNull();
  });

  it("groups two or more projects in the same folder and leaves single ones out", () => {
    const groups = buildAmuProjectGroups(
      [
        project("showa", `${home}/YouTube/showa`),
        project("kinoko", `${home}/YouTube/kinoko`),
        project("lp", `${home}/Sites/lp`),
      ],
      [],
    );
    expect(groups).toEqual([
      {
        scopeKey: `amu-group:auto:${home}/YouTube`,
        name: "YouTube",
        kind: "auto",
        projectKeys: ["showa", "kinoko"],
      },
    ]);
  });

  it("puts hand-made groups first and keeps their projects out of folder groups", () => {
    const groups = buildAmuProjectGroups(
      [
        project("showa", `${home}/YouTube/showa`),
        project("kinoko", `${home}/YouTube/kinoko`),
        project("amu", `${home}/Code/amu`),
      ],
      [{ id: "g1", name: "仕事", projectKeys: ["showa", "amu", "gone"] }],
    );
    expect(groups).toEqual([
      { scopeKey: "amu-group:g1", name: "仕事", kind: "manual", projectKeys: ["showa", "amu"] },
    ]);
  });
});
