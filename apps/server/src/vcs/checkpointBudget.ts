// @effect-diagnostics nodeBuiltinImport:off - metadata-only admission check at the Git process boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_FILE_BYTES = 50 * 1024 ** 2;
const MAX_TOTAL_BYTES = 1024 ** 3;
const MAX_FILES = 20_000;

/**
 * Refuse before git add hashes media into the object database. Never omit paths:
 * restore must not treat an omitted file as a deletion. Existing ignore rules
 * determine membership, including files deliberately tracked despite ignores.
 */
export async function checkCheckpointBudget(cwd: string, paths: ReadonlyArray<string>) {
  const unique = [...new Set(paths)];
  if (unique.length > MAX_FILES)
    return "Automatic checkpoint exceeds 20,000 files. Exclude generated files and dependencies.";
  let total = 0;
  for (const name of unique) {
    if (name.endsWith("/")) continue; // Embedded repositories are handled by Git.
    const info = await NodeFSP.lstat(NodePath.join(cwd, name)).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info?.isFile()) continue; // Symlink contents are not followed.
    if (info.size > MAX_FILE_BYTES)
      return "Automatic checkpoint contains a file over 50 MiB. Keep media and generated outputs outside checkpoint tracking.";
    total += info.size;
    if (total > MAX_TOTAL_BYTES)
      return "Automatic checkpoint exceeds 1 GiB. Exclude media, generated files and dependencies.";
  }
  return null;
}

/** Refuse further writes when another Git writer or a previous timeout left object temporaries. */
export async function hasCheckpointObjectTemps(commonDir: string) {
  const objects = NodePath.join(commonDir, "objects");
  const entries = await NodeFSP.readdir(objects, { withFileTypes: true });
  if (entries.some((entry) => entry.name.startsWith("tmp_"))) return true;
  for (const entry of entries) {
    if (!entry.isDirectory() || !(entry.name === "pack" || /^[0-9a-f]{2}$/.test(entry.name)))
      continue;
    const names = await NodeFSP.readdir(NodePath.join(objects, entry.name));
    if (names.some((name) => name.startsWith("tmp_"))) return true;
  }
  return false;
}
