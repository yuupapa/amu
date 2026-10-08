import { describe, expect, it } from "vite-plus/test";

import { applyThreadFolders, listedProjectIdLookup } from "./threadFolders";

const thread = (id: string, projectId: string, environmentId = "mac") => ({
  id,
  projectId,
  environmentId,
  title: id,
});

describe("listing a thread under another project", () => {
  const projects = [
    { id: "smoke", environmentId: "mac" },
    { id: "youtube", environmentId: "mac" },
    { id: "remote-project", environmentId: "other" },
  ];

  it("lists a thread under its chosen project, and leaves the thread itself as it is", () => {
    const threads = [thread("t1", "smoke"), thread("t2", "smoke")];
    const listed = listedProjectIdLookup({ t1: "youtube" }, projects, "mac");
    expect(threads.map(listed)).toEqual(["youtube", "smoke"]);
    expect(threads[0]!.projectId).toBe("smoke");
  });

  it("keeps a thread under its own project when the chosen one is gone", () => {
    const listed = listedProjectIdLookup({ t1: "deleted" }, projects, "mac");
    expect(listed(thread("t1", "smoke"))).toBe("smoke");
  });

  it("never lists another machine's thread differently, since the choices are this Mac's", () => {
    const listed = listedProjectIdLookup({ t9: "remote-project" }, projects, "mac");
    expect(listed(thread("t9", "x", "other"))).toBe("x");
  });

  it("counts a listed thread as the chosen project's work, and returns the same list when nothing changes", () => {
    const threads = [thread("t1", "smoke")];
    expect(applyThreadFolders(threads, {}, projects, "mac")).toBe(threads);
    expect(applyThreadFolders(threads, { t1: "youtube" }, projects, "mac")[0]!.projectId).toBe(
      "youtube",
    );
  });
});
