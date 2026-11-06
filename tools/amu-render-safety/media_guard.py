#!/usr/bin/env python3
"""macOS media preflight and an optional foreground job lock. Only its own child group may be stopped on resource exhaustion. No deletion."""
from __future__ import annotations
import argparse
import contextlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

GIB, MIB = 1024 ** 3, 1024 ** 2
DEFAULT_PROJECT = Path.home() / "Library/Application Support/amu/runtime/projects/project"
LOCK_DIR = Path("/private/tmp") / f"amu-media-guard-{os.getuid()}"
HEAVY_NAMES = {"blender", "ffmpeg", "chrome-headless-shell", "headlesschrome"}

def clean_env():
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(LC_ALL="C", GIT_OPTIONAL_LOCKS="0")
    return env

def command(argv, timeout=15):
    return subprocess.run(argv, check=True, capture_output=True, text=True,
                          timeout=timeout, env=clean_env()).stdout

def inside(path, root):
    return path.resolve().is_relative_to(root.resolve())

def memory_sample():
    level = int(command(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"]))
    swap = command(["/usr/sbin/sysctl", "-n", "vm.swapusage"])
    match = re.search(r"used\s*=\s*([\d.]+)([KMG])", swap)
    if not match:
        raise ValueError("vm.swapusageを解析できません")
    used = float(match[1]) * {"K": 1024, "M": MIB, "G": GIB}[match[2]]
    vm = command(["/usr/bin/vm_stat"])
    size = re.search(r"page size of (\d+) bytes", vm)
    if not size:
        raise ValueError("vm_statのページサイズを取得できません")
    values = {}
    for name in ("Swapins", "Swapouts"):
        found = re.search(rf"^{name}:\s+(\d+)", vm, re.M)
        if not found:
            raise ValueError(f"vm_statの{name}を取得できません")
        values[name] = int(found[1]) * int(size[1])
    return dict(pressure=level, swap_used_bytes=int(used), **values)

# 開始保留から外してよいプレビュー用ブラウザの親（Amu本体か hyperframes preview）。書き出し（render）は含めません。
PREVIEW_PARENT = re.compile(r"/Amu\.app/Contents/MacOS/Amu(\s|$)|hyperframes(@[\w.\-]+)?\s+preview(\s|$)")

def processes():
    rows, names = [], {}
    for line in command(["/bin/ps", "-Ao", "pid=,ppid=,etime=,comm="]).splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        pid, ppid, elapsed, executable = parts
        name = Path(executable).name
        names[int(pid)] = (int(ppid), name)
        if name.lower() in HEAVY_NAMES:
            rows.append(dict(pid=int(pid), ppid=int(ppid), elapsed=elapsed, name=name))
    if any(row["name"].lower() == "chrome-headless-shell" for row in rows):
        args = {}
        for line in command(["/bin/ps", "-Ao", "pid=,args="]).splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2:
                args[int(parts[0])] = parts[1]
        for row in rows:
            if row["name"].lower() != "chrome-headless-shell":
                continue
            # chrome-headless-shell の親子をさかのぼり、最初の別プロセスが Amu 本体か preview かを見ます
            parent, seen = row["ppid"], set()
            while parent in names and names[parent][1].lower() == "chrome-headless-shell" and parent not in seen:
                seen.add(parent)
                parent = names[parent][0]
            row["preview_parent"] = bool(PREVIEW_PARENT.search(args.get(parent, "")))
    return rows

def repository(project):
    root = Path(command(["git", "-C", str(project), "rev-parse", "--show-toplevel"]).strip())
    common = Path(command(["git", "-C", str(project), "rev-parse",
                           "--path-format=absolute", "--git-common-dir"]).strip())
    files = command(["git", "-C", str(root), "ls-files", "-z", "--cached",
                     "--others", "--exclude-standard"]).split("\0")
    total, count, big = 0, 0, []
    for name in set(files) - {""}:
        try:
            info = (root / name).lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(info.st_mode):
            continue
        count += 1
        total += info.st_size
        if info.st_size > 50 * MIB:
            big.append(dict(path=name, bytes=info.st_size))
    temps = []
    objects = common / "objects"
    for directory in [objects, objects / "pack", *objects.glob("[0-9a-f][0-9a-f]")]:
        for path in directory.glob("tmp_*"):
            try:
                info = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode):
                temps.append(dict(path=str(path.relative_to(common)), bytes=info.st_size,
                                  age_seconds=round(time.time() - info.st_mtime)))
    return dict(root=str(root.resolve()), candidate_count=count, candidate_bytes=total,
                large_files=sorted(big, key=lambda item: -item["bytes"]), temporary_files=temps)

def collect(projects, output_dir, sample_seconds=3.0):
    data = dict(time=dt.datetime.now().astimezone().isoformat(), errors=[],
                repositories=[], processes=[], output_dir=str(output_dir.resolve()))
    try:
        before = memory_sample()
        start = time.monotonic()
        time.sleep(sample_seconds)
        after = memory_sample()
        elapsed = time.monotonic() - start
        after["swap_io_mib_per_second"] = sum(max(0, after[k] - before[k])
                                             for k in ("Swapins", "Swapouts")) / MIB / elapsed
        after["sample_seconds"] = elapsed
        after["pressure_before"] = before["pressure"]
        data["memory"] = after
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        data["errors"].append(f"メモリの測定に失敗: {exc}")
    try:
        data["processes"] = processes()
    except (OSError, subprocess.SubprocessError) as exc:
        data["errors"].append(f"プロセス一覧の取得に失敗: {exc}")
    for project in dict.fromkeys(projects):
        try:
            data["repositories"].append(repository(project))
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            data["errors"].append(f"Gitの点検に失敗 ({project}): {exc}")
    try:
        if not output_dir.is_dir():
            raise ValueError("書き出し先には既存のフォルダを指定してください")
        data["internal_free_bytes"] = shutil.disk_usage(Path.home()).free
        data["output_free_bytes"] = shutil.disk_usage(output_dir).free
        result = subprocess.run(["git", "-C", str(output_dir), "rev-parse", "--show-toplevel"],
                                capture_output=True, text=True, timeout=10, env=clean_env())
        if result.returncode == 0:
            data["output_git_root"] = result.stdout.strip()
        elif result.returncode != 128 or "not a git repository" not in result.stderr.lower():
            raise ValueError("書き出し先がGit管理下か確認できません: " + result.stderr[:200])
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        data["errors"].append(f"保存先の点検に失敗: {exc}")
    return data

def evaluate(data, allow_preview_browsers=False):
    blocked, warnings = list(data["errors"]), []
    memory = data.get("memory")
    if memory:
        if memory["pressure"] != 1 or memory["pressure_before"] != 1:
            blocked.append("メモリプレッシャーが正常値1で安定していません")
        if memory["swap_io_mib_per_second"] > 32:
            blocked.append("測定中のスワップI/Oが32 MiB/秒を超えています。負荷が落ちてから再確認してください")
        if memory["swap_used_bytes"] > 4 * GIB:
            warnings.append("スワップが4 GiB超です。残量だけでは開始禁止にせず、圧迫状態とI/Oも判定します")
    allowed = [p for p in data["processes"] if allow_preview_browsers and p.get("preview_parent")]
    for process in data["processes"]:
        if process not in allowed:
            blocked.append(f"{process['name']} が稼働中: PID {process['pid']} / 経過 {process['elapsed']}")
    if allowed:
        warnings.append(f"Amu本体・Creatorプレビューの chrome-headless-shell {len(allowed)}個は --allow-preview-browsers により開始保留から外しました")
    for repo in data["repositories"]:
        if repo["temporary_files"]:
            blocked.append(f"Gitに作成中または残留した一時ファイルがあります: {len(repo['temporary_files'])}個 / {repo['root']}")
        if repo["large_files"]:
            blocked.append(f"50 MiB超のチェックポイント候補があります: {len(repo['large_files'])}個 / {repo['root']}")
        if repo["candidate_bytes"] > GIB:
            blocked.append(f"チェックポイント候補が1 GiBを超えています: {repo['root']}")
        if inside(Path(data["output_dir"]), Path(repo["root"])):
            blocked.append("書き出し先が点検対象のGit作業フォルダ内です")
    if data.get("output_git_root"):
        blocked.append("書き出し先がGit管理下です: " + data["output_git_root"])
    for key, label in (("internal_free_bytes", "内蔵ディスク"), ("output_free_bytes", "保存先")):
        if key in data and data[key] < 50 * GIB:
            blocked.append(f"{label}の空きが運用上の最低値50 GiB未満です")
    return dict(**data, status="BLOCKED" if blocked else "READY", blocked=blocked, warnings=warnings)

@contextlib.contextmanager
def exclusive_lock(directory=LOCK_DIR):
    directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("共有ロック用フォルダの所有者・権限が不正です")
    fd = os.open(directory / "heavy.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("共有ロックファイルを確認できません")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("別の処理が共通ロックを使用中です") from exc
        yield fd
    finally:
        # Keep the inode so a second caller cannot acquire a replacement lock.
        os.close(fd)

def display(result, report=None):
    if report:
        with report.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    print(f"{result['status']}  {result['time']}", flush=True)
    memory = result.get("memory")
    if memory:
        print(f"メモリ圧迫値 {memory['pressure']} / スワップ {memory['swap_used_bytes'] / GIB:.2f} GiB"
              f" / スワップI/O {memory['swap_io_mib_per_second']:.1f} MiB/秒", flush=True)
    for repo in result["repositories"]:
        print(f"Git候補 {repo['candidate_count']}個・{repo['candidate_bytes'] / MIB:.1f} MiB"
              f" / 一時ファイル {len(repo['temporary_files'])}個 / {repo['root']}", flush=True)
    for reason in result["blocked"]:
        print("開始保留: " + reason, flush=True)
    for warning in result["warnings"]:
        print("注意: " + warning, flush=True)
    if not result["blocked"]:
        print("開始前チェックを通過しました。runでは実行中も監視します。管理対象外の起動までは制御できません。", flush=True)

def run_job(argv, lock_fd, output_dir=None):
    child = subprocess.Popen(argv, start_new_session=True, pass_fds=(lock_fd,))
    entry = json.dumps(dict(pid=child.pid, launcher_pid=os.getpid(), program=Path(argv[0]).name,
                            started=dt.datetime.now().astimezone().isoformat())) + "\n"
    os.ftruncate(lock_fd, 0)
    os.lseek(lock_fd, 0, os.SEEK_SET)
    os.write(lock_fd, entry.encode())
    print(f"起動: PID {child.pid} / {Path(argv[0]).name} / ロック {LOCK_DIR / 'heavy.lock'}", flush=True)
    previous = {}
    def forward(signum, _frame):
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass
    for sig in (signal.SIGINT, signal.SIGTERM):
        previous[sig] = signal.signal(sig, forward)
    try:
        critical = 0
        while True:
            try:
                return child.wait(timeout=3 if output_dir is not None else None)
            except subprocess.TimeoutExpired:
                reason = None
                try:
                    level = memory_sample()["pressure"]
                    critical = critical + 1 if level >= 4 else 0
                    if critical >= 2:
                        reason = "重大なメモリ圧迫が続いています"
                    if any(shutil.disk_usage(p).free < 10 * GIB for p in (Path.home(), output_dir)):
                        reason = "空き容量が10 GiB未満です"
                except (OSError, ValueError, subprocess.SubprocessError):
                    reason = "実行中の資源監視に失敗しました"
                if reason:
                    print("中止: " + reason + "。このツールが起動した処理だけを終了します。", flush=True)
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait()
                    return 2
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    for name in ("check", "run"):
        part = sub.add_parser(name)
        part.add_argument("--project", type=Path, action="append", help="追加で点検するGit作業フォルダ")
        part.add_argument("--output-dir", type=Path, required=True)
        part.add_argument("--report", type=Path, help="新規JSONファイルに結果を保存")
        part.add_argument("--allow-preview-browsers", action="store_true",
                          help="親が Amu.app か hyperframes preview の chrome-headless-shell を開始保留の理由から外す")
        if name == "run":
            part.add_argument("job", nargs=argparse.REMAINDER, help="-- に続けて実行するコマンド")
    args = parser.parse_args(argv)
    projects = [DEFAULT_PROJECT, *(args.project or [])]
    job = getattr(args, "job", [])
    if job[:1] == ["--"]:
        job = job[1:]
    if args.mode == "run" and not job:
        parser.error("runには -- に続けて実行コマンドを指定してください")
    try:
        if args.mode == "check":
            result = evaluate(collect(projects, args.output_dir), args.allow_preview_browsers)
            display(result, args.report)
            return 2 if result["blocked"] else 0
        with exclusive_lock() as fd:
            result = evaluate(collect(projects, args.output_dir), args.allow_preview_browsers)
            display(result, args.report)
            if result["blocked"]:
                return 2
            return run_job(job, fd, output_dir=args.output_dir)
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print(f"開始保留: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    sys.exit(main())
