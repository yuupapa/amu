import { describe, expect, it } from "vite-plus/test";

import { applyThreadFolders } from "./threadFolders";

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
  ];

  it("shows a thread under its chosen project", () => {
    const listed = applyThreadFolders(
      [thread("t1", "smoke"), thread("t2", "smoke")],
      { t1: "youtube" },
      projects,
    );
    expect(listed.map((item) => item.projectId)).toEqual(["youtube", "smoke"]);
  });

  it("keeps the thread under its own project when the chosen one is gone or on another machine", () => {
    const threads = [thread("t1", "smoke"), thread("t2", "smoke", "other")];
    expect(applyThreadFolders(threads, { t1: "deleted", t2: "youtube" }, projects)).toBe(threads);
  });

  it("returns the same list when nothing is chosen", () => {
    const threads = [thread("t1", "smoke")];
    expect(applyThreadFolders(threads, {}, projects)).toBe(threads);
  });
});
