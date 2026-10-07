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

// A reinstalled Amu.app without that file must still open Amu's conversations,
// not upstream's ~/.t3 folder. Development runs (Electron from node_modules) never do this.
const packagedApp =
  resourcesPath !== undefined &&
  resourcesPath.endsWith(".app/Contents/Resources") &&
  !resourcesPath.includes(`${NodePath.sep}node_modules${NodePath.sep}`);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Runs in the boot script, before any Effect runtime exists.
if (process.env.T3CODE_HOME === undefined && process.platform === "darwin" && packagedApp) {
  const amuHome = NodePath.join(
    NodeOS.homedir(),
    "Library",
    "Application Support",
    "Amu",
    "runtime",
  );
  if (NodeFS.existsSync(NodePath.join(amuHome, "userdata"))) process.env.T3CODE_HOME = amuHome;
}
