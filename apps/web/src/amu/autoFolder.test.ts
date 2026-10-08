import { describe, expect, it } from "vite-plus/test";

import { AUTO_REQUEST_BYTE_BUDGET, withFolders } from "./autoFolder";

describe("Auto's folder context", () => {
  const body = { id: "luna-x", action: "decide", prompt: "依頼", models: [] };

  it("goes along when it fits", () => {
    const folders = { current: "/a", projects: [{ path: "/a", titles: ["題名"], updatedAt: "" }] };
    expect(withFolders(body, folders)).toEqual({ ...body, folders });
  });

  it("is left out when the request would pass the server's limit, so Auto still judges", () => {
    const projects = Array.from({ length: 400 }, (_, index) => ({
      path: `/work/project-${index}`,
      titles: ["と".repeat(60), "と".repeat(60), "と".repeat(60)],
      updatedAt: "2026-10-08T00:00:00Z",
    }));
    const result = withFolders(body, { current: "/work/project-0", projects });
    expect(result).toEqual(body);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
      AUTO_REQUEST_BYTE_BUDGET,
    );
  });

  it("is left out when there is none", () => {
    expect(withFolders(body, null)).toBe(body);
  });
});
