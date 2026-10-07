import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Amu's own update feed. Amu.app is signed ad hoc, so macOS's built-in
// updater (Squirrel.Mac) cannot install it. Each GitHub release instead
// carries a manifest and a zip with the app's code (app.asar and its unpacked
// files). The installer swaps those into the installed Amu.app and keeps the
// rest of the bundle, including Resources/amu-local.json.

export const AMU_UPDATE_REPOSITORY = "yuupapa/amu";

export const amuUpdateManifestName = (arch: string) => `amu-update-darwin-${arch}.json`;

/** GitHub serves the newest non-prerelease release under releases/latest. */
export const defaultAmuUpdateManifestUrl = (arch: string) =>
  `https://github.com/${AMU_UPDATE_REPOSITORY}/releases/latest/download/${amuUpdateManifestName(arch)}`;

/**
 * Reported once by the first check after the installer put the old version
 * back. The web notice matches this exact text (AmuAppUpdateNotification.logic.ts).
 */
export const AMU_ROLLED_BACK_MESSAGE =
  "The new version of Amu did not start, so Amu went back to this version.";

/**
 * Files under Contents/Resources an update may replace. Nothing else is
 * touched; amu-local.json and the CLIs in tooling/ in particular stay.
 * Besides the app code, the bundled packages and the resource monitor ship
 * with each build, so an update brings them along when its manifest lists them.
 */
export const AMU_REPLACEABLE_RESOURCES = [
  "app.asar",
  "app.asar.unpacked",
  "node_modules",
  "resource-monitor",
] as const;

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
/** Plain x.y.z only; the installer refuses anything else after Amu has quit. */
const ReleaseVersion = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/));

export const AmuUpdateManifest = Schema.Struct({
  schema: Schema.Literal(1),
  version: ReleaseVersion,
  releaseNotes: Schema.optional(Schema.String),
  releasePageUrl: Schema.optional(Schema.String),
  platform: Schema.Literal("darwin"),
  arch: Schema.String,
  electronVersion: Schema.String,
  payload: Schema.Struct({
    url: Schema.String,
    sha256: Sha256Hex,
    size: Schema.Number,
  }),
  asarIntegrityHash: Sha256Hex,
  replace: Schema.Array(Schema.Literals(AMU_REPLACEABLE_RESOURCES)),
});
export type AmuUpdateManifest = typeof AmuUpdateManifest.Type;

export const decodeAmuUpdateManifest = Schema.decodeUnknownEffect(AmuUpdateManifest);

const parseVersion = (version: string): Option.Option<readonly [number, number, number]> => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return Option.none();
  return Option.some([Number(match[1]), Number(match[2]), Number(match[3])] as const);
};

/** True when `candidate` is a plain x.y.z release newer than `current`. */
export function isNewerAmuVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  if (Option.isNone(next) || Option.isNone(now)) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = next.value[index]! - now.value[index]!;
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Why this install cannot take the update in place, or null when it can.
 * The swap keeps the installed Electron, so the new code must target the same
 * Electron and CPU.
 */
export function amuUpdateIncompatibility(
  manifest: AmuUpdateManifest,
  runtime: { readonly electronVersion: string; readonly arch: string },
): string | null {
  if (manifest.arch !== runtime.arch) {
    return `Amu ${manifest.version} is built for ${manifest.arch}, but this Mac runs ${runtime.arch}.`;
  }
  if (manifest.electronVersion !== runtime.electronVersion) {
    return `Amu ${manifest.version} needs Electron ${manifest.electronVersion} (this Amu has ${runtime.electronVersion}). Download it from the release page and replace Amu.app.`;
  }
  if (new Set(manifest.replace).size !== manifest.replace.length) {
    return `Amu ${manifest.version} lists the same file twice.`;
  }
  if (!manifest.replace.includes("app.asar")) {
    return `Amu ${manifest.version} has no app code to install.`;
  }
  return null;
}

/** Where to look for updates; absent when this build does not use Amu's feed. */
export class AmuUpdateFeed extends Context.Service<
  AmuUpdateFeed,
  {
    readonly manifestUrl: string;
    /** Folder for downloads, staging and backups. */
    readonly updatesDir: string;
  }
>()("@t3tools/desktop/updates/AmuUpdateFeed") {}
