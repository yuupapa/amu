// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off - Streams the update zip and starts the detached installer behind electron-updater's promise-shaped interface.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";
import * as NodeUtil from "node:util";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import {
  AMU_ROLLED_BACK_MESSAGE,
  amuUpdateIncompatibility,
  decodeAmuUpdateManifest,
  defaultAmuUpdateManifestUrl,
  isNewerAmuVersion,
  type AmuUpdateManifest,
} from "./AmuUpdateFeed.ts";
import {
  AMU_INSTALL_SCRIPT,
  amuInstallEnvironment,
  appBundleFromExecutable,
} from "./AmuUpdateInstaller.ts";

// Stands in for electron-updater on Amu.app (design: AmuUpdateFeed.ts). It
// speaks the same events, so DesktopUpdates and the sidebar update button
// work unchanged: check → "update-available", download → "update-downloaded",
// quitAndInstall → the detached installer swaps app.asar and reopens Amu.

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type Listener = (...args: Array<unknown>) => void;

// Electron's fs reads any "*.asar" path as a folder inside the archive. The
// staged app.asar is a plain file to this code, so use the unpatched fs.
const fs: typeof NodeFS = (() => {
  if (!process.versions.electron) return NodeFS;
  try {
    return NodeModule.createRequire(process.execPath)("original-fs") as typeof NodeFS;
  } catch {
    return NodeFS;
  }
})();
const NodeFSP = fs.promises;

// Errors the user should read as they are. Anything else (a network error,
// a disk error) gets the operation's plain fallback text.
const USER_FACING = Symbol("amu-user-facing");
const userFacing = (message: string) => Object.assign(new Error(message), { [USER_FACING]: true });
const detailFor = (cause: unknown, fallback: string) =>
  cause instanceof Error && USER_FACING in cause ? cause.message : fallback;

interface Prepared {
  readonly manifest: AmuUpdateManifest;
  readonly stagingDir: string;
  readonly asarIntegrityHash: string;
}

/** SHA-256 of the asar header string; Electron's ElectronAsarIntegrity value. */
export async function asarHeaderHash(asarPath: string): Promise<string> {
  const handle = await NodeFSP.open(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    const length = head.readUInt32LE(12);
    if (length <= 0 || length > 256 * 1024 * 1024) throw new Error("app.asar has no valid header.");
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 16);
    return NodeCrypto.createHash("sha256").update(header.toString("utf8")).digest("hex");
  } finally {
    await handle.close();
  }
}

/** Runs `use` with a signal that aborts when no progress was reported for `idleMs`. */
async function withIdleTimeout<A>(
  idleMs: number,
  use: (signal: AbortSignal, progress: () => void) => Promise<A>,
): Promise<A> {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), idleMs);
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), idleMs);
  };
  try {
    return await use(controller.signal, progress);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw userFacing("The update server stopped responding. Try again later.");
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export interface AmuReleaseUpdaterOptions {
  readonly manifestUrl: string;
  readonly updatesDir: string;
  readonly appVersion: string;
  readonly arch: string;
  readonly electronVersion: string;
  readonly executablePath: string;
  readonly port: string | undefined;
  readonly quitApp: () => void;
}

export function makeAmuReleaseUpdater(
  options: AmuReleaseUpdaterOptions,
): ElectronUpdater.ElectronUpdater["Service"] {
  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) => {
    for (const listener of listeners.get(eventName) ?? []) listener(...args);
  };
  let available: AmuUpdateManifest | null = null;
  let prepared: Prepared | null = null;

  const check = async () => {
    emit("checking-for-update");
    // The installer leaves this file when it had to restore the old version.
    const failurePath = NodePath.join(options.updatesDir, "last-failure.txt");
    if (fs.existsSync(failurePath)) {
      await NodeFSP.rm(failurePath, { force: true });
      throw userFacing(AMU_ROLLED_BACK_MESSAGE);
    }
    // The whole request, body included, must finish within the timeout.
    const body = await withIdleTimeout(FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(options.manifestUrl, { signal, redirect: "follow" });
      if (response.status === 404) return null;
      if (!response.ok) throw userFacing(`The update server answered ${response.status}.`);
      return (await response.json()) as unknown;
    });
    // No release carries a manifest yet.
    if (body === null) {
      emit("update-not-available");
      return;
    }
    const manifest = await Effect.runPromise(decodeAmuUpdateManifest(body)).catch(() => {
      throw userFacing("The update information could not be read.");
    });
    if (!isNewerAmuVersion(manifest.version, options.appVersion)) {
      emit("update-not-available");
      return;
    }
    const incompatibility = amuUpdateIncompatibility(manifest, {
      arch: options.arch,
      electronVersion: options.electronVersion,
    });
    if (incompatibility !== null) throw userFacing(incompatibility);
    available = manifest;
    emit("update-available", { version: manifest.version, releaseNotes: manifest.releaseNotes });
  };

  const download = async () => {
    const manifest = available;
    if (manifest === null) throw userFacing("No update is available to download.");
    const versionDir = NodePath.join(options.updatesDir, manifest.version);
    const zipPath = NodePath.join(versionDir, "payload.zip");
    const stagingDir = NodePath.join(versionDir, "staging");
    await NodeFSP.rm(versionDir, { recursive: true, force: true });
    await NodeFSP.mkdir(versionDir, { recursive: true });

    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    let lastPercent = -1;
    // A stalled connection aborts after a minute without data; disk errors
    // (a full disk) reject the pipeline instead of escaping as events.
    await withIdleTimeout(DOWNLOAD_IDLE_TIMEOUT_MS, async (signal, progress) => {
      const response = await fetch(manifest.payload.url, { signal, redirect: "follow" });
      if (!response.ok || response.body === null) {
        throw userFacing(`The update download answered ${response.status}.`);
      }
      const meter = new NodeStream.Transform({
        transform(chunk: Buffer, _encoding, callback) {
          progress();
          received += chunk.byteLength;
          if (received > manifest.payload.size) {
            callback(userFacing("The downloaded update is damaged. Try again."));
            return;
          }
          hash.update(chunk);
          const percent = Math.min(100, Math.floor((received / manifest.payload.size) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            emit("download-progress", { percent });
          }
          callback(null, chunk);
        },
      });
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.fromWeb(response.body as NodeStreamWeb.ReadableStream<Uint8Array>),
        meter,
        fs.createWriteStream(zipPath),
        { signal },
      );
    });
    if (received !== manifest.payload.size || hash.digest("hex") !== manifest.payload.sha256) {
      throw userFacing("The downloaded update is damaged. Try again.");
    }

    await NodeFSP.mkdir(stagingDir, { recursive: true });
    await execFile("/usr/bin/ditto", ["-x", "-k", zipPath, stagingDir]);
    for (const item of manifest.replace) {
      await NodeFSP.access(NodePath.join(stagingDir, item));
    }
    const asarIntegrityHash = await asarHeaderHash(NodePath.join(stagingDir, "app.asar"));
    if (asarIntegrityHash !== manifest.asarIntegrityHash) {
      throw userFacing("The downloaded update does not match its release.");
    }
    await NodeFSP.rm(zipPath, { force: true });
    prepared = { manifest, stagingDir, asarIntegrityHash };
    emit("update-downloaded", { version: manifest.version, releaseNotes: manifest.releaseNotes });
  };

  const install = () => {
    const ready = prepared;
    if (ready === null) throw userFacing("No downloaded update is ready to install.");
    const appBundlePath = appBundleFromExecutable(options.executablePath);
    if (appBundlePath === null) throw userFacing("Amu is not running from an app bundle.");
    const scriptPath = NodePath.join(options.updatesDir, "install-update.sh");
    fs.writeFileSync(scriptPath, AMU_INSTALL_SCRIPT, { mode: 0o700 });
    const child = NodeChildProcess.spawn("/bin/bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...amuInstallEnvironment({
          appPid: process.pid,
          appBundlePath,
          stagingDir: ready.stagingDir,
          updatesDir: options.updatesDir,
          logPath: NodePath.join(options.updatesDir, "install.log"),
          version: ready.manifest.version,
          oldVersion: options.appVersion,
          asarIntegrityHash: ready.asarIntegrityHash,
          replace: ready.manifest.replace,
          port: options.port,
        }),
        // Test hooks: how to reopen Amu and how long to wait for it.
        ...(process.env.AMU_INSTALL_OPEN ? { AMU_OPEN: process.env.AMU_INSTALL_OPEN } : {}),
        ...(process.env.AMU_INSTALL_HEALTH_TIMEOUT
          ? { AMU_HEALTH_TIMEOUT: process.env.AMU_INSTALL_HEALTH_TIMEOUT }
          : {}),
      },
    });
    child.unref();
    options.quitApp();
  };

  const noop = () => Effect.void;
  return ElectronUpdater.ElectronUpdater.of({
    setFeedURL: noop,
    setAutoDownload: noop,
    setAutoInstallOnAppQuit: noop,
    setChannel: noop,
    setAllowPrerelease: noop,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: noop,
    setFullChangelog: noop,
    setDisableDifferentialDownload: noop,
    checkForUpdates: Effect.tryPromise({
      try: check,
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
          channel: null,
          cause,
          detail: detailFor(cause, "Could not reach GitHub to check for Amu updates."),
        }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: download,
      catch: (cause) =>
        new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
          channel: null,
          cause,
          detail: detailFor(
            cause,
            "Could not download the update. Check the connection and try again.",
          ),
        }),
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: install,
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
            detail: detailFor(cause, "Could not start the update installer."),
          }),
      }),
    on: (eventName, listener) => {
      const untyped = listener as unknown as Listener;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const set = listeners.get(eventName) ?? new Set<Listener>();
          set.add(untyped);
          listeners.set(eventName, set);
        }),
        () => Effect.sync(() => listeners.get(eventName)?.delete(untyped)),
      ).pipe(Effect.asVoid);
    },
  });
}

/**
 * Amu's updater when this build uses Amu's feed, or none (electron-updater
 * then stays in charge). Set AMU_UPDATE_MANIFEST_URL to test against another
 * manifest, or to "off" to turn updates off.
 */
export class AmuReleaseUpdater extends Context.Service<
  AmuReleaseUpdater,
  { readonly updater: Option.Option<ElectronUpdater.ElectronUpdater["Service"]> }
>()("@t3tools/desktop/updates/AmuReleaseUpdater") {}

export const layer = Layer.effect(
  AmuReleaseUpdater,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const override = process.env.AMU_UPDATE_MANIFEST_URL?.trim();
    const active =
      environment.platform === "darwin" &&
      environment.isPackaged &&
      appBundleFromExecutable(process.execPath) !== null &&
      override !== "off";
    if (!active) return { updater: Option.none() };
    const updatesDir = environment.path.join(environment.baseDir, "amu-updates");
    yield* Effect.promise(() => NodeFSP.mkdir(updatesDir, { recursive: true }));
    return {
      updater: Option.some(
        makeAmuReleaseUpdater({
          manifestUrl: override || defaultAmuUpdateManifestUrl(environment.processArch),
          updatesDir,
          appVersion: environment.appVersion,
          arch: environment.processArch,
          electronVersion: process.versions.electron ?? "",
          executablePath: process.execPath,
          port: process.env.T3CODE_PORT,
          quitApp: () => Electron.app.quit(),
        }),
      ),
    };
  }),
);
