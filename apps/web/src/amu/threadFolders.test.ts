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

describe("answers arriving out of order", () => {
  it("keeps the newest revision", async () => {
    const { acceptAnswer, currentThreadFolders } = await import("./threadFolders");
    expect(acceptAnswer({ entries: { t1: "a" }, revision: 5 })).toBe(true);
    expect(acceptAnswer({ entries: { t1: "b" }, revision: 6 })).toBe(true);
    // The answer to the earlier save arrives last.
    expect(acceptAnswer({ entries: { t1: "a" }, revision: 5 })).toBe(false);
    expect(currentThreadFolders()).toEqual({ t1: "b" });
  });
});

describe("project rows keep their list when nothing in them changed", () => {
  it("reuses the previous array for an unchanged project and replaces a changed one", async () => {
    const { keepUnchangedLists } = await import("./threadFolders");
    const a = { id: "a" },
      b = { id: "b" },
      c = { id: "c" };
    const first = keepUnchangedLists(
      new Map([
        ["p1", [a, b]],
        ["p2", [c]],
      ]),
      null,
    );
    const second = keepUnchangedLists(
      new Map([
        ["p1", [a, b]],
        ["p2", [c, a]],
      ]),
      first,
    );
    expect(second.get("p1")).toBe(first.get("p1"));
    expect(second.get("p2")).not.toBe(first.get("p2"));
  });
});
