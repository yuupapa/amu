// @effect-diagnostics nodeBuiltinImport:off - Packaged boot config runs before the Effect runtime exists.
// Local installation paths only; never contains provider credentials or pairing tokens.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Amu.app carries Resources/amu-local.json with the data folder and port of
// this install. Updates replace app.asar but keep this file, so the updated
// app opens the same conversations.
const resourcesPath = process.resourcesPath;
if (resourcesPath) {
  const configPath = NodePath.join(resourcesPath, "amu-local.json");
  if (NodeFS.existsSync(configPath)) {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    for (const name of ["T3CODE_HOME", "T3CODE_PORT"]) {
      const value = config[name];
      if (typeof value === "string" && value.length > 0 && process.env[name] === undefined) {
        process.env[name] = value;
      }
    }
  }
}

/**
 * Defaults for a packaged Amu that has no amu-local.json (a new or reinstalled
 * install): its data stays in Amu's own folder, never in upstream T3 Code's
 * ~/.t3. Windows also pins the port the Mac install uses, and never relies on
 * amu-local.json because an NSIS update replaces the whole install folder.
 * Development runs (Electron from node_modules) get nothing.
 */
export function resolveAmuRuntimeDefaults(input: {
  readonly platform: string;
  readonly resourcesPath: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}): Record<string, string> {
  const { platform, resourcesPath, env, homedir } = input;
  if (resourcesPath === undefined) return {};
  if (platform === "darwin") {
    const packagedApp =
      resourcesPath.endsWith(".app/Contents/Resources") &&
      !resourcesPath.includes("/node_modules/");
    if (!packagedApp || env.T3CODE_HOME !== undefined) return {};
    return {
      T3CODE_HOME: NodePath.posix.join(homedir, "Library", "Application Support", "Amu", "runtime"),
    };
  }
  if (platform === "win32") {
    if (resourcesPath.toLowerCase().includes("\\node_modules\\")) return {};
    const defaults: Record<string, string> = {};
    if (env.T3CODE_HOME === undefined) {
      const appData = env.APPDATA ?? NodePath.win32.join(homedir, "AppData", "Roaming");
      defaults.T3CODE_HOME = NodePath.win32.join(appData, "Amu", "runtime");
    }
    if (env.T3CODE_PORT === undefined) defaults.T3CODE_PORT = "5233";
    return defaults;
  }
  return {};
}

Object.assign(
  process.env,
  resolveAmuRuntimeDefaults({
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs in the boot script, before any Effect runtime exists.
    platform: process.platform,
    resourcesPath,
    env: process.env,
    homedir: NodeOS.homedir(),
  }),
);
