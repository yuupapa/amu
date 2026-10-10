#!/usr/bin/env node
// Builds an Amu release for Apple Silicon Macs and, with --publish, puts it on
// GitHub (yuupapa/amu). The installed Amu checks the release's manifest and
// swaps in the app code from the update zip (apps/desktop/src/updates).
//
//   node scripts/amu-release.mjs --notes-file notes.md            # build only
//   node scripts/amu-release.mjs --notes-file notes.md --publish  # build and publish
//
// Publishing needs `gh` logged in to an account that can write to yuupapa/amu,
// and the current commit pushed there. The release starts as a draft; the
// amu-windows-release.yml workflow adds the Windows installer and publishes it,
// so Windows updaters never find a release without its latest.yml.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const REPOSITORY = "yuupapa/amu";
const ARCH = "arm64";
const root = NodePath.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const publish = args.includes("--publish");
const notesIndex = args.indexOf("--notes-file");
const notesFile = notesIndex >= 0 ? args[notesIndex + 1] : undefined;
if (!notesFile) throw new Error("Pass --notes-file with the release notes (Markdown list).");
const releaseNotes = NodeFS.readFileSync(notesFile, "utf8").trim();

const version = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "apps/desktop/package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${version}`);
const tag = `v${version}`;
// The release zip must be built from exactly the commit the tag points at.
// Untracked files count too (a new source file would be in the zip but not in
// the tag); only notes under docs/, which the app does not contain, are ignored.
const dirty = NodeChildProcess.execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all"],
  {
    cwd: root,
  },
)
  .toString()
  .split("\n")
  .filter(
    (line) =>
      line.trim() !== "" &&
      // A rename lists both paths; both must be under docs/ to be ignored.
      !line
        .slice(3)
        .split(" -> ")
        .every((path) => path.replace(/^"/, "").startsWith("docs/")),
  )
  .join("\n");
if (dirty && publish) throw new Error(`Commit these changes before publishing:\n${dirty}`);
if (dirty) console.warn("Building from uncommitted changes; this build cannot be published.");
const out = NodePath.join(root, "release", `amu-${version}`);
const run = (command, commandArgs, options = {}) =>
  NodeChildProcess.execFileSync(command, commandArgs, { stdio: "inherit", cwd: root, ...options });
const plist = (path, key) =>
  NodeChildProcess.execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, path])
    .toString()
    .trim();
const sha256 = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

function asarHeaderHash(path) {
  const fd = NodeFS.openSync(path, "r");
  const head = Buffer.alloc(16);
  NodeFS.readSync(fd, head, 0, 16, 0);
  const header = Buffer.alloc(head.readUInt32LE(12));
  NodeFS.readSync(fd, header, 0, header.length, 16);
  return NodeCrypto.createHash("sha256").update(header.toString("utf8")).digest("hex");
}

// The resource monitor needs Rust 1.95 or newer (sysinfo 0.39.3). Check before
// the long build; cargo runs from the repo root, so ask rustc from there too.
const rustc = NodeChildProcess.execFileSync("rustc", ["--version"], { cwd: root })
  .toString()
  .trim();
const [, rustMajor, rustMinor] = rustc.match(/^rustc (\d+)\.(\d+)\./) ?? [];
if (!rustMajor || Number(rustMajor) * 1000 + Number(rustMinor) < 1095) {
  throw new Error(
    `The resource monitor needs Rust 1.95 or newer, but rustc is "${rustc}".\n` +
      "Run with RUSTUP_TOOLCHAIN=1.95.0 (install it with: rustup toolchain install 1.95.0).",
  );
}

NodeFS.rmSync(out, { recursive: true, force: true });
NodeFS.mkdirSync(out, { recursive: true });

run("node", [
  "scripts/build-desktop-artifact.ts",
  "--platform",
  "mac",
  "--target",
  "zip",
  "--arch",
  ARCH,
  "--output-dir",
  NodePath.join(out, "build"),
]);

const builtZip = NodePath.join(out, "build", `T3-Code-${version}-${ARCH}.zip`);
run("/usr/bin/ditto", ["-x", "-k", builtZip, NodePath.join(out, "app")]);
const app = NodePath.join(out, "app", "Amu.app");
const resources = NodePath.join(app, "Contents/Resources");
const builtVersion = plist(
  NodePath.join(app, "Contents/Info.plist"),
  ":CFBundleShortVersionString",
);
if (builtVersion !== version) throw new Error(`Built ${builtVersion}, expected ${version}.`);
// Amu's identity (withAmuMacIdentity in build-desktop-artifact.ts). A new
// install keeps this Info.plist for good, since updates replace only Resources.
const info = JSON.parse(
  NodeChildProcess.execFileSync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    NodePath.join(app, "Contents/Info.plist"),
  ]).toString(),
);
const [urlType, ...otherUrlTypes] = info.CFBundleURLTypes ?? [];
const identityProblems = [
  info.CFBundleIdentifier !== "local.amu.desktop" &&
    `CFBundleIdentifier is ${info.CFBundleIdentifier}, expected local.amu.desktop`,
  (otherUrlTypes.length > 0 ||
    urlType?.CFBundleURLName !== "Amu" ||
    urlType?.CFBundleTypeRole !== "Editor" ||
    JSON.stringify(urlType?.CFBundleURLSchemes) !== '["amu"]') &&
    `CFBundleURLTypes is ${JSON.stringify(info.CFBundleURLTypes)}, expected only amu`,
  info.CFBundleDocumentTypes && "CFBundleDocumentTypes is present",
  ...Object.entries(info)
    .filter(([, value]) => /T3 Code|t3code/.test(JSON.stringify(value)))
    .map(([key]) => `${key} still names T3 Code`),
].filter(Boolean);
if (identityProblems.length > 0) {
  throw new Error(`Amu.app does not have Amu's identity:\n- ${identityProblems.join("\n- ")}`);
}
const electronVersion = plist(
  NodePath.join(app, "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"),
  ":CFBundleVersion",
);

// The update zip: the app code and the parts that ship with it (the list in
// apps/desktop/src/updates/AmuUpdateFeed.ts). The installed bundle keeps the
// rest, amu-local.json included.
const REPLACEABLE = ["app.asar", "app.asar.unpacked", "node_modules", "resource-monitor"];
const replace = REPLACEABLE.filter((item) => NodeFS.existsSync(NodePath.join(resources, item)));
const payloadDir = NodePath.join(out, "payload");
NodeFS.mkdirSync(payloadDir);
for (const item of replace) {
  run("/usr/bin/ditto", [NodePath.join(resources, item), NodePath.join(payloadDir, item)]);
}
const payloadName = `amu-update-${version}-darwin-${ARCH}.zip`;
const payloadPath = NodePath.join(out, payloadName);
run("/usr/bin/ditto", ["-c", "-k", payloadDir, payloadPath]);

const manifestName = `amu-update-darwin-${ARCH}.json`;
const manifest = {
  schema: 1,
  version,
  releaseNotes,
  releasePageUrl: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
  platform: "darwin",
  arch: ARCH,
  electronVersion,
  payload: {
    url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${payloadName}`,
    sha256: sha256(payloadPath),
    size: NodeFS.statSync(payloadPath).size,
  },
  asarIntegrityHash: asarHeaderHash(NodePath.join(resources, "app.asar")),
  replace,
};
NodeFS.writeFileSync(NodePath.join(out, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);

// The whole app, for a new install.
const appZipName = `Amu-${version}-mac-${ARCH}.zip`;
run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, NodePath.join(out, appZipName)]);

console.log(`\nAmu ${version} (Electron ${electronVersion}) is in ${out}`);
if (!publish) process.exit(0);

const commit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
  .toString()
  .trim();
run("gh", [
  "release",
  "create",
  tag,
  "--repo",
  REPOSITORY,
  "--draft",
  "--target",
  commit,
  "--title",
  `Amu ${version}`,
  "--notes-file",
  notesFile,
  NodePath.join(out, manifestName),
  payloadPath,
  NodePath.join(out, appZipName),
]);
run("gh", [
  "workflow",
  "run",
  "amu-windows-release.yml",
  "--repo",
  REPOSITORY,
  "-f",
  `tag=${tag}`,
  "-f",
  `commit=${commit}`,
]);
console.log(
  `\n${tag} is a draft until the Windows build publishes it. If that build fails,\n` +
    `publish the Mac release alone: gh release edit ${tag} --repo ${REPOSITORY} --draft=false --latest`,
);
