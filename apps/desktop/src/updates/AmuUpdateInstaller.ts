import { AMU_REPLACEABLE_RESOURCES } from "./AmuUpdateFeed.ts";

// The installer runs as a detached shell process after Amu quits, because a
// running app cannot replace its own app.asar. It copies the staged files
// into the bundle under temporary names, then swaps them in by renames inside
// Resources, so the old files are never half copied. It updates the asar hash
// and version in Info.plist and opens Amu again. When the new Amu does not
// come up, it renames the old files back and opens the old one. Inputs come
// only through AMU_* environment variables.

export const AMU_INSTALL_SCRIPT = `#!/bin/bash
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
log() { printf '%s %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" >> "$AMU_LOG"; }

case "$AMU_APP" in /*.app) ;; *) log "refusing app path: $AMU_APP"; exit 2 ;; esac
SEEN=" "
for item in $AMU_REPLACE; do
  case "$item" in ${AMU_REPLACEABLE_RESOURCES.join("|")}) ;; *) log "refusing item: $item"; exit 2 ;; esac
  case "$SEEN" in *" $item "*) log "refusing duplicate item: $item"; exit 2 ;; esac
  SEEN="$SEEN$item "
done
case "$AMU_ASAR_HASH" in *[!0-9a-f]*|"") log "refusing asar hash"; exit 2 ;; esac
case "$AMU_VERSION" in *[!0-9.]*|"") log "refusing version: $AMU_VERSION"; exit 2 ;; esac

CONTENTS="$AMU_APP/Contents"
RES="$CONTENTS/Resources"
PLIST="$CONTENTS/Info.plist"
SAVED_PLIST="$CONTENTS/.amu-old-Info.plist"
PB=/usr/libexec/PlistBuddy
OPEN="\${AMU_OPEN:-/usr/bin/open}"
HEALTH_TIMEOUT="\${AMU_HEALTH_TIMEOUT:-180}"
APP_REAL="$(cd "$AMU_APP" 2>/dev/null && pwd -P)"

# A process belongs to Amu when its executable lives in this bundle. The
# path is compared as a plain prefix, never as a pattern.
in_bundle() {
  case "$1" in "$CONTENTS/"*) return 0 ;; esac
  [ -n "$APP_REAL" ] && case "$1" in "$APP_REAL/Contents/"*) return 0 ;; esac
  return 1
}
app_pids() {
  ps -axo pid=,comm= | while read -r pid comm; do
    [ "$pid" = "$$" ] && continue
    in_bundle "$comm" && echo "$pid"
  done
}
port_busy() { [ -n "\${AMU_PORT:-}" ] && lsof -nP -iTCP:"$AMU_PORT" -sTCP:LISTEN >/dev/null 2>&1; }
port_held_by_app() {
  local pid
  for pid in $(lsof -nP -iTCP:"$AMU_PORT" -sTCP:LISTEN -t 2>/dev/null); do
    in_bundle "$(ps -p "$pid" -o comm= 2>/dev/null)" && return 0
  done
  return 1
}
healthy() {
  [ -n "$(app_pids)" ] || return 1
  [ -z "\${AMU_PORT:-}" ] || port_held_by_app
}
wait_pid_exit() { local i=0; while kill -0 "$1" 2>/dev/null; do i=$((i + 1)); [ "$i" -ge "$2" ] && return 1; sleep 1; done; return 0; }
wait_port_free() { local i=0; while port_busy; do i=$((i + 1)); [ "$i" -ge "$1" ] && return 1; sleep 1; done; return 0; }
launch() { "$OPEN" "$AMU_APP" >> "$AMU_LOG" 2>&1; }
stop_app() {
  local pid i=0
  for pid in $(app_pids); do kill "$pid" 2>/dev/null; done
  while [ -n "$(app_pids)" ] && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 1; done
  for pid in $(app_pids); do kill -9 "$pid" 2>/dev/null; done
}

log "installing Amu $AMU_VERSION over $AMU_OLD_VERSION"
if ! wait_pid_exit "$AMU_PID" 120; then log "Amu did not quit; update skipped"; exit 1; fi
if ! wait_port_free 60; then log "port $AMU_PORT is still in use; update skipped"; launch; exit 1; fi

# Leftovers of an earlier run. Amu was just running, so the live files work.
# A leftover that cannot be removed would swallow the live folder on rename.
for item in $AMU_REPLACE; do
  # Only the app code must already be there; a part new in this version is added.
  [ "$item" != "app.asar" ] || [ -e "$RES/$item" ] || { log "update skipped: $item is missing"; launch; exit 1; }
  rm -rf "$RES/.amu-new-$item" "$RES/.amu-failed-$item" "$RES/.amu-old-$item"
  if [ -e "$RES/.amu-new-$item" ] || [ -e "$RES/.amu-failed-$item" ] || [ -e "$RES/.amu-old-$item" ]; then
    log "update skipped: could not clear an earlier attempt for $item"; launch; exit 1
  fi
done
rm -f "$SAVED_PLIST"

# 1. Copy the new files next to the live ones. Nothing live changes yet.
skip() {
  log "update skipped: $1"
  for item in $AMU_REPLACE; do rm -rf "$RES/.amu-new-$item"; done
  rm -f "$SAVED_PLIST"
  launch
  exit 1
}
for item in $AMU_REPLACE; do
  ditto "$AMU_STAGING/$item" "$RES/.amu-new-$item" || skip "could not copy the new $item"
done
cp -p "$PLIST" "$SAVED_PLIST" || skip "could not save Info.plist"

# 2. Swap by renames inside Resources, which cannot leave half a file.
SWAPPED=""
WAS_ABSENT=""
restore() {
  local item status=0
  for item in $SWAPPED; do
    # Rename the new file away first, so the old one never lands inside a
    # leftover folder; deleting comes last and may fail harmlessly.
    if [ -e "$RES/$item" ] && ! mv "$RES/$item" "$RES/.amu-failed-$item"; then
      status=1
      continue
    fi
    case " $WAS_ABSENT " in *" $item "*) ;; *) mv "$RES/.amu-old-$item" "$RES/$item" || status=1 ;; esac
  done
  for item in $AMU_REPLACE; do rm -rf "$RES/.amu-new-$item" "$RES/.amu-failed-$item"; done
  cp -p "$SAVED_PLIST" "$PLIST" || status=1
  [ "$status" -eq 0 ] && rm -f "$SAVED_PLIST"
  return "$status"
}
fail() {
  log "update failed: $1; restoring Amu $AMU_OLD_VERSION"
  printf '%s\\n' "$AMU_VERSION: $1" > "$AMU_UPDATES/last-failure.txt"
  stop_app
  wait_port_free 60
  if ! restore; then log "RESTORE INCOMPLETE: check $RES for .amu-old-* files"; fi
  launch
  exit 1
}
for item in $AMU_REPLACE; do
  if [ -e "$RES/$item" ]; then
    mv "$RES/$item" "$RES/.amu-old-$item" || fail "could not move $item aside"
  else
    WAS_ABSENT="$WAS_ABSENT $item"
  fi
  SWAPPED="$SWAPPED $item"
  mv "$RES/.amu-new-$item" "$RES/$item" || fail "could not move the new $item in"
done
if "$PB" -c "Print :ElectronAsarIntegrity" "$PLIST" >/dev/null 2>&1; then
  "$PB" -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $AMU_ASAR_HASH" "$PLIST" || fail "could not update the asar hash"
fi
"$PB" -c "Set :CFBundleShortVersionString $AMU_VERSION" "$PLIST" || fail "could not update the version"
"$PB" -c "Set :CFBundleVersion $AMU_VERSION" "$PLIST" || fail "could not update the version"
for item in $AMU_REPLACE; do xattr -dr com.apple.quarantine "$RES/$item" 2>/dev/null; done

# 3. Open the new Amu. Healthy once it runs and, when it pins a port, its own
# backend holds that port.
launch
i=0
until healthy; do
  i=$((i + 1))
  [ "$i" -ge "$HEALTH_TIMEOUT" ] && fail "the new Amu did not start"
  sleep 1
done
log "Amu $AMU_VERSION is running"
rm -f "$AMU_UPDATES/last-failure.txt" "$SAVED_PLIST"
rm -rf "$AMU_STAGING"

# 4. Keep the previous files as one backup outside the bundle.
ls -d "$AMU_UPDATES"/backup-* 2>/dev/null | while IFS= read -r old; do rm -rf "$old"; done
BACKUP="$AMU_UPDATES/backup-$AMU_OLD_VERSION"
mkdir -p "$BACKUP"
for item in $AMU_REPLACE; do
  [ -e "$RES/.amu-old-$item" ] || continue
  if ! mv "$RES/.amu-old-$item" "$BACKUP/$item"; then
    rm -rf "$BACKUP/$item"
    log "kept the previous $item inside the app; the next update removes it"
  fi
done
exit 0
`;

export interface AmuInstallInput {
  readonly appPid: number;
  readonly appBundlePath: string;
  readonly stagingDir: string;
  readonly updatesDir: string;
  readonly logPath: string;
  readonly version: string;
  readonly oldVersion: string;
  readonly asarIntegrityHash: string;
  readonly replace: ReadonlyArray<(typeof AMU_REPLACEABLE_RESOURCES)[number]>;
  readonly port: string | undefined;
}

export function amuInstallEnvironment(input: AmuInstallInput): Record<string, string> {
  return {
    AMU_PID: String(input.appPid),
    AMU_APP: input.appBundlePath,
    AMU_STAGING: input.stagingDir,
    AMU_UPDATES: input.updatesDir,
    AMU_LOG: input.logPath,
    AMU_VERSION: input.version,
    AMU_OLD_VERSION: input.oldVersion,
    AMU_ASAR_HASH: input.asarIntegrityHash,
    AMU_REPLACE: input.replace.join(" "),
    ...(input.port ? { AMU_PORT: input.port } : {}),
  };
}

/** The .app bundle that holds the running executable, or null outside one. */
export function appBundleFromExecutable(executablePath: string): string | null {
  const match = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath);
  return match ? match[1]! : null;
}
