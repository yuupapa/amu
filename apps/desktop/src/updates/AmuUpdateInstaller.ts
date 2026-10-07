import { AMU_REPLACEABLE_RESOURCES } from "./AmuUpdateFeed.ts";

// The installer runs as a detached shell process after Amu quits, because a
// running app cannot replace its own app.asar. It copies the staged files and
// an edited Info.plist into the bundle under temporary names, then swaps them
// in by renames inside the bundle, so no file is ever half copied and the
// swap itself takes milliseconds. It opens Amu again; when the new Amu does
// not come up, it renames the old files back and opens the old one.
//
// A journal outside the bundle records how far the swap got, and a watchdog
// job in launchd (loaded from the updates folder, gone after a restart) runs
// this same script with AMU_MODE=recover if the installer dies on the way: it
// restores the old files or finishes the health check the installer began.
// Inputs come only through AMU_* environment variables.

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
MODE="\${AMU_MODE:-install}"
case "$MODE" in install|recover) ;; *) log "refusing mode: $MODE"; exit 2 ;; esac

CONTENTS="$AMU_APP/Contents"
RES="$CONTENTS/Resources"
PLIST="$CONTENTS/Info.plist"
SAVED_PLIST="$CONTENTS/.amu-old-Info.plist"
NEW_PLIST="$CONTENTS/.amu-new-Info.plist"
PB=/usr/libexec/PlistBuddy
OPEN="\${AMU_OPEN:-/usr/bin/open}"
LAUNCHCTL="\${AMU_LAUNCHCTL:-/bin/launchctl}"
HEALTH_TIMEOUT="\${AMU_HEALTH_TIMEOUT:-180}"
WATCH_INTERVAL="\${AMU_WATCH_INTERVAL:-15}"
APP_REAL="$(cd "$AMU_APP" 2>/dev/null && pwd -P)"
SCRIPT="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)/$(basename "$0")"
JOURNAL="$AMU_UPDATES/install-journal"
# One job per bundle and updates folder, so updating one Amu never unloads
# the watchdog of another on the same Mac.
WATCH_LABEL="com.yuupapa.amu.update-watchdog.$(md5 -q -s "$AMU_APP|$AMU_UPDATES" | cut -c1-12)"
WATCH_PLIST="$AMU_UPDATES/update-watchdog.plist"
WATCH_DOMAIN="gui/$(id -u)"

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
  for pid in $(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null); do
    in_bundle "$(ps -p "$pid" -o comm= 2>/dev/null)" && return 0
  done
  return 1
}
# The backend answers HTTP at all (any status), not just holds the port.
answers() {
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null)"
  [ -n "$code" ] && [ "$code" != "000" ]
}
LAUNCH_MARK="$AMU_UPDATES/.launched"
STATE_FILE="\${AMU_STATE_DIR:-}/server-runtime.json"
# What the new backend wrote about itself after this launch, if anything.
runtime_field() {
  [ -n "\${AMU_STATE_DIR:-}" ] && [ "$STATE_FILE" -nt "$LAUNCH_MARK" ] || return 0
  sed -n "s/.*\\"$1\\":\\\\([0-9][0-9]*\\\\).*/\\\\1/p" "$STATE_FILE"
}
healthy() {
  [ -n "$(app_pids)" ] || return 1
  if [ -z "\${AMU_STATE_DIR:-}" ]; then
    # Without a state folder, the pinned port is all there is to check.
    [ -n "\${AMU_PORT:-}" ] || return 0
    port_held_by_app "$AMU_PORT" && answers "$AMU_PORT"
    return
  fi
  # The backend that wrote the state file after this launch must be a
  # process of this bundle, hold the port it wrote, and answer there.
  local port pid
  port="$(runtime_field port)"
  pid="$(runtime_field pid)"
  [ -n "$port" ] && [ -n "$pid" ] || return 1
  [ -z "\${AMU_PORT:-}" ] || [ "$port" = "$AMU_PORT" ] || return 1
  in_bundle "$(ps -p "$pid" -o comm= 2>/dev/null)" || return 1
  lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 1
  answers "$port"
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
boot_time() { sysctl -n kern.boottime 2>/dev/null | sed -n 's/^[^0-9]*\\([0-9][0-9]*\\).*/\\1/p'; }

# The journal: which phase the swap is in, who is running it, and which
# parts the old Amu did not have. Written whole, then renamed into place.
# The command line is stored as ps shows it, so the owner check compares
# like with like however the script path was spelled.
write_journal() {
  local command
  command="$(own_command)"
  # Without it a recovery could not tell this process is alive.
  [ -n "$command" ] || return 1
  printf 'phase=%s\\npid=%s\\nboot=%s\\ncommand=%s\\nabsent=%s\\n' "$1" "$$" "$(boot_time)" \
    "$command" "$WAS_ABSENT" > "$JOURNAL.tmp" &&
    mv -f "$JOURNAL.tmp" "$JOURNAL"
}
own_command() { ps -p "$$" -o command= 2>/dev/null; }
# The process that wrote the journal is still at work: same boot, alive, and
# running the same command it recorded.
journal_owner_alive() {
  local owner command current
  owner="$(journal_field pid)"
  case "$owner" in ""|*[!0-9]*) return 1 ;; esac
  [ "$owner" != "$$" ] || return 1
  [ "$(journal_field boot)" = "$(boot_time)" ] || return 1
  kill -0 "$owner" 2>/dev/null || return 1
  command="$(journal_field command)"
  current="$(ps -p "$owner" -o command= 2>/dev/null)"
  # A process that exists but cannot be looked up counts as alive; the
  # watchdog asks again in a few seconds.
  [ -z "$current" ] || [ "$current" = "$command" ]
}
journal_field() { sed -n "s/^$1=//p" "$JOURNAL" 2>/dev/null | head -n 1; }

xml() { printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g'; }
# Loads a launchd job that runs this script with AMU_MODE=recover every few
# seconds. It is loaded from the updates folder, so a restart drops it.
start_watchdog() {
  local name
  "$LAUNCHCTL" bootout "$WATCH_DOMAIN/$WATCH_LABEL" >/dev/null 2>&1
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\\n<plist version="1.0"><dict>\\n'
    printf '<key>Label</key><string>%s</string>\\n' "$WATCH_LABEL"
    printf '<key>ProgramArguments</key><array><string>/bin/bash</string><string>%s</string></array>\\n' "$(xml "$SCRIPT")"
    printf '<key>StartInterval</key><integer>%s</integer>\\n' "$WATCH_INTERVAL"
    printf '<key>EnvironmentVariables</key><dict>\\n'
    printf '<key>AMU_MODE</key><string>recover</string>\\n'
    for name in AMU_PID AMU_APP AMU_STAGING AMU_UPDATES AMU_LOG AMU_VERSION AMU_OLD_VERSION AMU_ASAR_HASH AMU_REPLACE AMU_PORT AMU_STATE_DIR AMU_OPEN AMU_HEALTH_TIMEOUT; do
      [ -n "\${!name:-}" ] || continue
      printf '<key>%s</key><string>%s</string>\\n' "$name" "$(xml "\${!name}")"
    done
    printf '</dict>\\n</dict></plist>\\n'
  } > "$WATCH_PLIST.tmp" && mv -f "$WATCH_PLIST.tmp" "$WATCH_PLIST" ||
    { log "could not write the update watchdog"; return 1; }
  "$LAUNCHCTL" bootstrap "$WATCH_DOMAIN" "$WATCH_PLIST" >> "$AMU_LOG" 2>&1
}
# Last step on every way out: unloading the job also ends a running recovery.
stop_watchdog() {
  rm -f "$WATCH_PLIST"
  "$LAUNCHCTL" bootout "$WATCH_DOMAIN/$WATCH_LABEL" >/dev/null 2>&1
}

# Puts back whatever the files on disk say was swapped, so it works both
# right after a failed check and for a recovery after the installer died.
restore() {
  local item status=0 absent
  absent=" \${WAS_ABSENT:-} "
  for item in $AMU_REPLACE; do
    if [ -e "$RES/.amu-old-$item" ]; then
      # Rename the new file away first, so the old one never lands inside a
      # leftover folder; deleting comes last and may fail harmlessly.
      if [ -e "$RES/$item" ] && ! mv "$RES/$item" "$RES/.amu-failed-$item"; then
        status=1
        continue
      fi
      mv "$RES/.amu-old-$item" "$RES/$item" || status=1
    else
      case "$absent" in
        *" $item "*) if [ -e "$RES/$item" ]; then mv "$RES/$item" "$RES/.amu-failed-$item" || status=1; fi ;;
      esac
    fi
  done
  for item in $AMU_REPLACE; do rm -rf "$RES/.amu-new-$item" "$RES/.amu-failed-$item"; done
  rm -f "$NEW_PLIST"
  if [ -e "$SAVED_PLIST" ]; then mv -f "$SAVED_PLIST" "$PLIST" || status=1; fi
  return "$status"
}
fail() {
  log "update failed: $1; restoring Amu $AMU_OLD_VERSION"
  # From here a recovery must keep restoring, never take the old Amu for the
  # new. Until that is on disk nothing is restored; the watchdog tries again.
  if ! write_journal rollback; then
    log "could not record the rollback; the watchdog will retry it"
    exit 1
  fi
  stop_app
  wait_port_free 60
  if ! restore; then
    # The journal and the watchdog stay, so the restore is tried again; Amu
    # is not opened on a half-restored bundle.
    log "RESTORE INCOMPLETE: the watchdog will retry; check $RES for .amu-old-* files"
    exit 1
  fi
  rm -f "$JOURNAL"
  # Read by the next Amu as "the update was undone", so only now.
  printf '%s\\n' "$AMU_VERSION: $1" > "$AMU_UPDATES/last-failure.txt"
  launch
  stop_watchdog
  exit 1
}

# 3. Healthy once the new Amu runs and its own backend holds its port and
# answers there. Then keep the previous files as one backup outside the bundle.
verify_and_finish() {
  local i=0
  until healthy; do
    i=$((i + 1))
    [ "$i" -ge "$HEALTH_TIMEOUT" ] && fail "the new Amu did not start"
    sleep 1
  done
  log "Amu $AMU_VERSION is running"
  rm -f "$JOURNAL" "$AMU_UPDATES/last-failure.txt" "$SAVED_PLIST"
  rm -rf "$AMU_STAGING"
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
  stop_watchdog
  exit 0
}

if [ "$MODE" = recover ]; then
  [ -f "$JOURNAL" ] || { stop_watchdog; exit 0; }
  PHASE="$(journal_field phase)"
  journal_owner_alive && exit 0
  WAS_ABSENT=""
  for item in $(journal_field absent); do
    case " $AMU_REPLACE " in *" $item "*) WAS_ABSENT="$WAS_ABSENT $item" ;; esac
  done
  log "the installer stopped during the $PHASE phase; finishing the update for it"
  case "$PHASE" in
    verify)
      # The installer may have died before it opened the new Amu.
      if [ -z "$(app_pids)" ]; then
        touch "$LAUNCH_MARK"
        # As in the install: a state file written in the same second as the
        # mark would not count as newer.
        sleep 1
        launch
      fi
      verify_and_finish
      ;;
    *) fail "the installer stopped while swapping files" ;;
  esac
fi

log "installing Amu $AMU_VERSION over $AMU_OLD_VERSION"
if ! wait_pid_exit "$AMU_PID" 120; then log "Amu did not quit; update skipped"; exit 1; fi
if ! wait_port_free 60; then log "port $AMU_PORT is still in use; update skipped"; launch; exit 1; fi

# An unfinished earlier update comes first: its journal and the old files it
# would restore must survive. Make sure its watchdog is there (a restart
# drops it), without unloading one that may be restoring right now.
if [ -f "$JOURNAL" ]; then
  log "update skipped: an earlier update is unfinished ($(journal_field phase) phase)"
  # Reload the earlier job file as it was: it holds that update's parts and
  # versions, which this update's may not match. The watchdog opens Amu once
  # it has finished, so Amu is not opened here on a bundle it may be restoring.
  if "$LAUNCHCTL" print "$WATCH_DOMAIN/$WATCH_LABEL" >/dev/null 2>&1; then
    exit 1
  fi
  if [ -f "$WATCH_PLIST" ] &&
    "$LAUNCHCTL" bootstrap "$WATCH_DOMAIN" "$WATCH_PLIST" >> "$AMU_LOG" 2>&1; then
    exit 1
  fi
  # Nobody can finish it: open Amu as it is, so it is not left closed.
  log "the earlier update's watchdog could not be started; restore by hand from $RES/.amu-old-*"
  launch
  exit 1
fi
# Leftovers of an earlier, finished run. Amu was just running, so the live
# files work. A leftover that cannot be removed would swallow the live folder
# on rename.
stop_watchdog
rm -f "$JOURNAL.tmp"
WAS_ABSENT=""
for item in $AMU_REPLACE; do
  # Only the app code must already be there; a part new in this version is added.
  [ "$item" != "app.asar" ] || [ -e "$RES/$item" ] || { log "update skipped: $item is missing"; launch; exit 1; }
  [ -e "$RES/$item" ] || WAS_ABSENT="$WAS_ABSENT $item"
  rm -rf "$RES/.amu-new-$item" "$RES/.amu-failed-$item" "$RES/.amu-old-$item"
  if [ -e "$RES/.amu-new-$item" ] || [ -e "$RES/.amu-failed-$item" ] || [ -e "$RES/.amu-old-$item" ]; then
    log "update skipped: could not clear an earlier attempt for $item"; launch; exit 1
  fi
done
rm -f "$SAVED_PLIST" "$NEW_PLIST"

# 1. Copy the new files and the edited Info.plist next to the live ones.
# Nothing live changes yet.
skip() {
  log "update skipped: $1"
  for item in $AMU_REPLACE; do rm -rf "$RES/.amu-new-$item"; done
  rm -f "$SAVED_PLIST" "$NEW_PLIST"
  launch
  exit 1
}
for item in $AMU_REPLACE; do
  ditto "$AMU_STAGING/$item" "$RES/.amu-new-$item" || skip "could not copy the new $item"
done
cp -p "$PLIST" "$SAVED_PLIST" || skip "could not save Info.plist"
cp -p "$PLIST" "$NEW_PLIST" || skip "could not copy Info.plist"
if "$PB" -c "Print :ElectronAsarIntegrity" "$NEW_PLIST" >/dev/null 2>&1; then
  "$PB" -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash $AMU_ASAR_HASH" "$NEW_PLIST" || skip "could not update the asar hash"
fi
"$PB" -c "Set :CFBundleShortVersionString $AMU_VERSION" "$NEW_PLIST" || skip "could not update the version"
"$PB" -c "Set :CFBundleVersion $AMU_VERSION" "$NEW_PLIST" || skip "could not update the version"

# 2. Swap by renames inside the bundle, which cannot leave half a file. From
# here the journal and the watchdog can finish the job if this process dies.
write_journal swap || skip "could not write the update journal"
if ! start_watchdog; then
  rm -f "$JOURNAL"
  stop_watchdog
  skip "could not start the update watchdog"
fi
for item in $AMU_REPLACE; do
  if [ -e "$RES/$item" ]; then
    mv "$RES/$item" "$RES/.amu-old-$item" || fail "could not move $item aside"
  fi
  mv "$RES/.amu-new-$item" "$RES/$item" || fail "could not move the new $item in"
done
mv -f "$NEW_PLIST" "$PLIST" || fail "could not put the new Info.plist in place"
for item in $AMU_REPLACE; do xattr -dr com.apple.quarantine "$RES/$item" 2>/dev/null; done
write_journal verify || log "could not record the swap as done; a recovery would restore the old Amu"

touch "$LAUNCH_MARK"
sleep 1
launch
verify_and_finish
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
  /** The server's state folder, where the backend writes server-runtime.json. */
  readonly stateDir?: string | undefined;
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
    ...(input.stateDir ? { AMU_STATE_DIR: input.stateDir } : {}),
  };
}

/** The .app bundle that holds the running executable, or null outside one. */
export function appBundleFromExecutable(executablePath: string): string | null {
  const match = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath);
  return match ? match[1]! : null;
}
