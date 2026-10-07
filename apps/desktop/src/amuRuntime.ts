// @effect-diagnostics nodeBuiltinImport:off - Packaged boot config runs before the Effect runtime exists.
// Local installation paths only; never contains provider credentials or pairing tokens.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Amu.app carries Resources/amu-local.json with the data folder and port of
// this install. Updates replace app.asar but keep this file, so the updated
// app opens the same conversations.
const resourcesPath = process.resourcesPath;
if (resourcesPath) {
  const configPath = NodePath.join(resourcesPath, "amu-local.json");
  if (NodeFS.existsSync(configPath)) {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    for (const name of ["T3CODE_HOME", "T3CODE_PORT", "T3CODE_JEV_RUNNER", "T3CODE_JEV_PYTHON"]) {
      const value = config[name];
      if (typeof value === "string" && value.length > 0 && process.env[name] === undefined) {
        process.env[name] = value;
      }
    }
  }
}
