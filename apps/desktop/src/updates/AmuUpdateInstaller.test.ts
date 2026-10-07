// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Runs the real installer script against a fake bundle and times other processes around it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  AMU_INSTALL_SCRIPT,
  amuInstallEnvironment,
  appBundleFromExecutable,
} from "./AmuUpdateInstaller.ts";

const isMac = HostProcessPlatform.defaultValue() === "darwin";
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleShortVersionString</key><string>0.0.44</string>
<key>CFBundleVersion</key><string>0.0.44</string>
<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict>
<key>algorithm</key><string>SHA256</string><key>hash</key><string>${"0".repeat(64)}</string>
</dict></dict>
</dict></plist>`;

let root: string;
let fakeAppBinary: string;
let app: string;
let staging: string;
let updates: string;

const read = (path: string) => NodeFS.readFileSync(path, "utf8");
const plistValue = (key: string) =>
  NodeChildProcess.execFileSync("/usr/libexec/PlistBuddy", [
    "-c",
    `Print ${key}`,
    NodePath.join(app, "Contents/Info.plist"),
  ])
    .toString()
    .trim();

/** PIDs whose executable lives in the fake bundle, like the installer's own check. */
function bundlePids(): number[] {
  return NodeChildProcess.execFileSync("/bin/ps", ["-axo", "pid=,comm="])
    .toString()
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .flatMap((match) =>
      match && match[2]!.startsWith(`${app}/Contents/`) ? [Number(match[1])] : [],
    );
}

function runInstaller(extra: Record<string, string>) {
  const scriptPath = NodePath.join(updates, "install-update.sh");
  NodeFS.writeFileSync(scriptPath, AMU_INSTALL_SCRIPT, { mode: 0o700 });
  // A process that has already exited stands in for the quitting Amu.
  const quitPid = NodeChildProcess.spawnSync("/usr/bin/true").pid ?? 999_999;
  return NodeChildProcess.spawnSync("/bin/bash", [scriptPath], {
    env: {
      ...amuInstallEnvironment({
        appPid: quitPid,
        appBundlePath: app,
        stagingDir: staging,
        updatesDir: updates,
        logPath: NodePath.join(updates, "install.log"),
        version: "0.0.45",
        oldVersion: "0.0.44",
        asarIntegrityHash: "c".repeat(64),
        replace: ["app.asar", "app.asar.unpacked"],
        port: undefined,
      }),
      ...extra,
    },
    timeout: 30_000,
  });
}

// A tiny "app" that sleeps. macOS kills copies of its own system binaries
// started from another path, so build one instead.
beforeAll(() => {
  if (!isMac) return;
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-fake-app-"));
  fakeAppBinary = NodePath.join(dir, "Amu");
  NodeChildProcess.execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", fakeAppBinary], {
    input:
      "#include <stdlib.h>\n#include <unistd.h>\nint main(int c, char **v) { sleep(c > 1 ? atoi(v[1]) : 20); return 0; }\n",
  });
});

afterAll(() => {
  if (fakeAppBinary)
    NodeFS.rmSync(NodePath.dirname(fakeAppBinary), { recursive: true, force: true });
});

beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-install-"));
  app = NodePath.join(root, "Amu.app");
  staging = NodePath.join(root, "staging");
  updates = NodePath.join(root, "updates");
  const resources = NodePath.join(app, "Contents/Resources");
  NodeFS.mkdirSync(NodePath.join(resources, "app.asar.unpacked"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(app, "Contents/MacOS"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(app, "Contents/Info.plist"), PLIST);
  NodeFS.writeFileSync(NodePath.join(resources, "app.asar"), "old code");
  NodeFS.writeFileSync(NodePath.join(resources, "app.asar.unpacked/native.node"), "old native");
  NodeFS.writeFileSync(NodePath.join(resources, "amu-local.json"), '{"T3CODE_PORT":"5233"}');
  if (isMac) NodeFS.copyFileSync(fakeAppBinary, NodePath.join(app, "Contents/MacOS/Amu"));
  NodeFS.mkdirSync(NodePath.join(staging, "app.asar.unpacked"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(staging, "app.asar"), "new code");
  NodeFS.writeFileSync(NodePath.join(staging, "app.asar.unpacked/native.node"), "new native");
  NodeFS.mkdirSync(updates, { recursive: true });
});

afterEach(() => {
  for (const pid of bundlePids()) process.kill(pid, "SIGKILL");
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!isMac)("Amu update installer", () => {
  it("swaps the app code, keeps the rest and records the new version", () => {
    const launcher = NodePath.join(root, "launch.sh");
    NodeFS.writeFileSync(launcher, '#!/bin/sh\n"$1/Contents/MacOS/Amu" 20 >/dev/null 2>&1 &\n', {
      mode: 0o755,
    });
    const result = runInstaller({ AMU_OPEN: launcher, AMU_HEALTH_TIMEOUT: "10" });

    expect(result.status, read(NodePath.join(updates, "install.log"))).toBe(0);
    const resources = NodePath.join(app, "Contents/Resources");
    expect(read(NodePath.join(resources, "app.asar"))).toBe("new code");
    expect(read(NodePath.join(resources, "app.asar.unpacked/native.node"))).toBe("new native");
    expect(read(NodePath.join(resources, "amu-local.json"))).toContain("5233");
    expect(plistValue(":CFBundleShortVersionString")).toBe("0.0.45");
    expect(plistValue(":ElectronAsarIntegrity:Resources/app.asar:hash")).toBe("c".repeat(64));
    expect(read(NodePath.join(updates, "backup-0.0.44/app.asar"))).toBe("old code");
    expect(NodeFS.existsSync(staging)).toBe(false);
    // No temporary files stay in the bundle.
    expect(NodeFS.readdirSync(resources).filter((name) => name.startsWith(".amu-"))).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(app, "Contents/.amu-old-Info.plist"))).toBe(false);
  });

  it("restores the old app when the new one does not start", () => {
    const result = runInstaller({ AMU_OPEN: "/usr/bin/true", AMU_HEALTH_TIMEOUT: "2" });

    expect(result.status).toBe(1);
    const resources = NodePath.join(app, "Contents/Resources");
    expect(read(NodePath.join(resources, "app.asar"))).toBe("old code");
    expect(read(NodePath.join(resources, "app.asar.unpacked/native.node"))).toBe("old native");
    expect(plistValue(":CFBundleShortVersionString")).toBe("0.0.44");
    expect(plistValue(":ElectronAsarIntegrity:Resources/app.asar:hash")).toBe("0".repeat(64));
    expect(read(NodePath.join(updates, "last-failure.txt"))).toContain("did not start");
    expect(NodeFS.readdirSync(resources).filter((name) => name.startsWith(".amu-"))).toEqual([]);
  });

  it("leaves everything alone while another process holds Amu's port", async () => {
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? String(address.port) : "0";
    try {
      // The installer waits up to 60 s for the port; run it in the background
      // and give up early once the log shows it is waiting.
      const scriptPath = NodePath.join(updates, "install-update.sh");
      NodeFS.writeFileSync(scriptPath, AMU_INSTALL_SCRIPT, { mode: 0o700 });
      const child = NodeChildProcess.spawn("/bin/bash", [scriptPath], {
        env: {
          ...amuInstallEnvironment({
            appPid: 999_999,
            appBundlePath: app,
            stagingDir: staging,
            updatesDir: updates,
            logPath: NodePath.join(updates, "install.log"),
            version: "0.0.45",
            oldVersion: "0.0.44",
            asarIntegrityHash: "c".repeat(64),
            replace: ["app.asar", "app.asar.unpacked"],
            port,
          }),
          AMU_OPEN: "/usr/bin/true",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      child.kill("SIGKILL");
      expect(read(NodePath.join(app, "Contents/Resources/app.asar"))).toBe("old code");
      expect(plistValue(":CFBundleShortVersionString")).toBe("0.0.44");
    } finally {
      server.close();
    }
  });

  it("restores the old app when its port is taken by someone else", async () => {
    const launcher = NodePath.join(root, "launch.sh");
    NodeFS.writeFileSync(launcher, '#!/bin/sh\n"$1/Contents/MacOS/Amu" 20 >/dev/null 2>&1 &\n', {
      mode: 0o755,
    });
    const probe = NodeNet.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const scriptPath = NodePath.join(updates, "install-update.sh");
    NodeFS.writeFileSync(scriptPath, AMU_INSTALL_SCRIPT, { mode: 0o700 });
    const run = NodeChildProcess.spawn("/bin/bash", [scriptPath], {
      env: {
        ...amuInstallEnvironment({
          appPid: 999_999,
          appBundlePath: app,
          stagingDir: staging,
          updatesDir: updates,
          logPath: NodePath.join(updates, "install.log"),
          version: "0.0.45",
          oldVersion: "0.0.44",
          asarIntegrityHash: "c".repeat(64),
          replace: ["app.asar", "app.asar.unpacked"],
          port: String(port),
        }),
        AMU_OPEN: launcher,
        AMU_HEALTH_TIMEOUT: "4",
      },
    });
    // After the swap starts, another process takes the port, so the new app
    // runs but its backend cannot listen. Release it once the check gave up.
    const blocker = NodeNet.createServer();
    setTimeout(() => blocker.listen(port, "127.0.0.1"), 500);
    setTimeout(() => blocker.close(), 7_000);
    const status = await new Promise<number | null>((resolve) => run.on("exit", resolve));

    expect(status).toBe(1);
    expect(read(NodePath.join(app, "Contents/Resources/app.asar"))).toBe("old code");
    expect(plistValue(":CFBundleShortVersionString")).toBe("0.0.44");
    expect(read(NodePath.join(updates, "last-failure.txt"))).toContain("did not start");
  }, 30_000);

  it("refuses a file listed twice", () => {
    const result = runInstaller({ AMU_REPLACE: "app.asar app.asar" });

    expect(result.status).toBe(2);
    expect(read(NodePath.join(app, "Contents/Resources/app.asar"))).toBe("old code");
  });

  it("refuses to touch anything outside the allowed files", () => {
    const result = runInstaller({ AMU_REPLACE: "app.asar amu-local.json" });

    expect(result.status).toBe(2);
    expect(read(NodePath.join(app, "Contents/Resources/app.asar"))).toBe("old code");
  });
});

describe("appBundleFromExecutable", () => {
  it("finds the bundle that holds the executable", () => {
    expect(appBundleFromExecutable("/Users/me/Applications/Amu.app/Contents/MacOS/Amu")).toBe(
      "/Users/me/Applications/Amu.app",
    );
  });

  it("returns null outside a bundle", () => {
    expect(appBundleFromExecutable("/usr/local/bin/electron")).toBeNull();
  });
});
