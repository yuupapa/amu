// @effect-diagnostics nodeBuiltinImport:off - a temporary folder with a fake executable only.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { findExecutable, parseGrokDeviceLogin } from "./GrokAuth.ts";

describe("parseGrokDeviceLogin", () => {
  it("reads the address and code once the CLI has printed them", () => {
    const output =
      "\u001b[1mOpen this link to sign in:\u001b[0m\n" +
      "  \u001b[4mhttps://accounts.x.ai/oauth2/device?user_code=ABCD-1234\u001b[0m\n" +
      "Code: ABCD-1234\n";
    expect(parseGrokDeviceLogin(output)).toEqual({
      url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
      userCode: "ABCD-1234",
    });
  });

  it("waits while the address is not there yet", () => {
    expect(parseGrokDeviceLogin("Starting sign-in…\n")).toBeNull();
    expect(parseGrokDeviceLogin("https://accounts.x.ai/oauth2/device?user_code=")).toBeNull();
  });

  it("does not take an address on another site", () => {
    expect(
      parseGrokDeviceLogin("https://example.com/oauth2/device?user_code=ABCD-1234"),
    ).toBeNull();
  });
});

describe("findExecutable", () => {
  it("finds a command on PATH, or as given, and nothing that cannot run", () => {
    const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-auth-"));
    try {
      const grok = NodePath.join(folder, "grok");
      NodeFS.writeFileSync(grok, "#!/bin/sh\n", { mode: 0o755 });
      NodeFS.writeFileSync(NodePath.join(folder, "plain"), "", { mode: 0o644 });
      const environment = { PATH: `/nonexistent${NodePath.delimiter}${folder}` };
      expect(findExecutable("grok", environment)).toBe(grok);
      expect(findExecutable(grok, {})).toBe(grok);
      expect(findExecutable("plain", environment)).toBeNull();
      expect(findExecutable("missing", environment)).toBeNull();
      expect(findExecutable("grok", {})).toBeNull();
    } finally {
      NodeFS.rmSync(folder, { recursive: true, force: true });
    }
  });
});
