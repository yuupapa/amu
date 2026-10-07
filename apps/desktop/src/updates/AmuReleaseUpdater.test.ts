// @effect-diagnostics nodeBuiltinImport:off - Serves a real manifest and zip over loopback.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { asarHeaderHash, makeAmuReleaseUpdater } from "./AmuReleaseUpdater.ts";

const isMac = HostProcessPlatform.defaultValue() === "darwin";

/** The smallest asar Electron would read: size pickle, header pickle, one byte of data. */
function writeAsar(path: string) {
  const json = Buffer.from('{"files":{"a.txt":{"size":1,"offset":"0"}}}');
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  NodeFS.writeFileSync(path, Buffer.concat([size, header, Buffer.from("x")]));
}

let root: string;
let server: NodeHttp.Server;
let baseUrl: string;
let files: Map<string, Buffer>;

beforeEach(async () => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-updater-"));
  files = new Map();
  server = NodeHttp.createServer((request, response) => {
    const body = files.get(request.url ?? "");
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  NodeFS.rmSync(root, { recursive: true, force: true });
});

async function publish(options: { version: string; corruptZip?: boolean }) {
  const payloadDir = NodePath.join(root, "payload");
  NodeFS.mkdirSync(NodePath.join(payloadDir, "app.asar.unpacked"), { recursive: true });
  writeAsar(NodePath.join(payloadDir, "app.asar"));
  NodeFS.writeFileSync(NodePath.join(payloadDir, "app.asar.unpacked/native.node"), "native");
  const zipPath = NodePath.join(root, "payload.zip");
  NodeChildProcess.execFileSync("/usr/bin/ditto", ["-c", "-k", payloadDir, zipPath]);
  const zip = NodeFS.readFileSync(zipPath);
  files.set("/payload.zip", options.corruptZip ? Buffer.concat([zip, Buffer.from("!")]) : zip);
  files.set(
    "/manifest.json",
    Buffer.from(
      JSON.stringify({
        schema: 1,
        version: options.version,
        releaseNotes: "- New things",
        platform: "darwin",
        arch: "arm64",
        electronVersion: "44.4.2",
        payload: {
          url: `${baseUrl}/payload.zip`,
          sha256: NodeCrypto.createHash("sha256").update(zip).digest("hex"),
          size: zip.length,
        },
        asarIntegrityHash: await asarHeaderHash(NodePath.join(payloadDir, "app.asar")),
        replace: ["app.asar", "app.asar.unpacked"],
      }),
    ),
  );
}

/** An updater whose events are recorded for the rest of the test's scope. */
const makeUpdater = Effect.gen(function* () {
  const events: Array<[string, unknown]> = [];
  const updater = makeAmuReleaseUpdater({
    manifestUrl: `${baseUrl}/manifest.json`,
    updatesDir: NodePath.join(root, "updates"),
    appVersion: "0.0.44",
    arch: "arm64",
    electronVersion: "44.4.2",
    executablePath: "/Applications/Amu.app/Contents/MacOS/Amu",
    port: undefined,
    quitApp: () => undefined,
  });
  yield* Effect.forEach(
    ["update-available", "update-not-available", "update-downloaded", "download-progress"],
    (name) => updater.on(name, (payload: unknown) => events.push([name, payload])),
  );
  return { updater, events };
});

const publishing = (options: { version: string; corruptZip?: boolean }) =>
  Effect.promise(() => publish(options));

describe.skipIf(!isMac)("makeAmuReleaseUpdater", () => {
  it.effect("reports no update when no release has a manifest yet", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { updater, events } = yield* makeUpdater;
        yield* updater.checkForUpdates;
        expect(events.map(([name]) => name)).toEqual(["update-not-available"]);
      }),
    ),
  );

  it.effect("reports no update for the same version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* publishing({ version: "0.0.44" });
        const { updater, events } = yield* makeUpdater;
        yield* updater.checkForUpdates;
        expect(events.map(([name]) => name)).toEqual(["update-not-available"]);
      }),
    ),
  );

  it.effect("offers, downloads and stages a newer release", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* publishing({ version: "0.0.45" });
        const { updater, events } = yield* makeUpdater;
        yield* updater.checkForUpdates;
        expect(events[0]).toEqual([
          "update-available",
          { version: "0.0.45", releaseNotes: "- New things" },
        ]);

        yield* updater.downloadUpdate;
        expect(events.at(-1)).toEqual([
          "update-downloaded",
          { version: "0.0.45", releaseNotes: "- New things" },
        ]);
        expect(events.some(([name]) => name === "download-progress")).toBe(true);
        const staging = NodePath.join(root, "updates/0.0.45/staging");
        expect(NodeFS.existsSync(NodePath.join(staging, "app.asar"))).toBe(true);
        expect(
          NodeFS.readFileSync(NodePath.join(staging, "app.asar.unpacked/native.node"), "utf8"),
        ).toBe("native");
      }),
    ),
  );

  it.effect("refuses a damaged download", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* publishing({ version: "0.0.45", corruptZip: true });
        const { updater, events } = yield* makeUpdater;
        yield* updater.checkForUpdates;
        const exit = yield* Effect.exit(updater.downloadUpdate);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(events.some(([name]) => name === "update-downloaded")).toBe(false);
      }),
    ),
  );

  it.effect("will not install before a download is staged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { updater } = yield* makeUpdater;
        const exit = yield* Effect.exit(
          updater.quitAndInstall({ isSilent: true, isForceRunAfter: true }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    ),
  );
});
