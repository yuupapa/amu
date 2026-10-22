/**
 * The pinned CLI has no admission hook. Its Studio adapter owns the real render
 * promise, including cancellation cleanup. Transform only that adapter in
 * memory, refusing an incompatible version. HTTP "cancelled" is too early to
 * release a lock: the renderer still has to unwind.
 */
export const renderLeaseProgram = String.raw`import fcntl,json,os,pathlib,re,select,shutil,stat,subprocess,sys,time
root=pathlib.Path(sys.argv[1]).resolve()
def emit(**data):
 print(json.dumps(data),flush=True)
def command(args):
 return subprocess.check_output(args,text=True,timeout=5,env={**os.environ,"LC_ALL":"C"})
def memory():
 level=int(command(["/usr/sbin/sysctl","-n","kern.memorystatus_vm_pressure_level"]))
 vm=command(["/usr/bin/vm_stat"])
 page=int(re.search(r"page size of (\d+) bytes",vm)[1])
 total=sum(int(re.search(r"^"+n+r":\s+(\d+)",vm,re.M)[1])*page for n in ["Swapins","Swapouts"])
 return level,total
try:
 directory=pathlib.Path("/private/tmp")/("amu-media-guard-"+str(os.getuid()))
 directory.mkdir(mode=0o700,exist_ok=True)
 info=directory.lstat()
 if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise RuntimeError("Unsafe media lock directory")
 fd=os.open(directory/"heavy.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
 info=os.fstat(fd)
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid(): raise RuntimeError("Unsafe media lock file")
 try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError: raise RuntimeError("Another media job is running. Wait for it to finish.")
 if not root.is_dir(): raise RuntimeError("Render folder is unavailable")
 for line in command(["/bin/ps","-Ao","comm="]).splitlines():
  if pathlib.Path(line.strip()).name.lower() in {"blender","ffmpeg"}: raise RuntimeError("Blender or FFmpeg is running. Wait for it to finish.")
 before,io0=memory()
 started=time.monotonic()
 time.sleep(3)
 after,io1=memory()
 if before!=1 or after!=1 or (io1-io0)/(time.monotonic()-started)>32*1024**2:
  raise RuntimeError("Memory pressure is high. Wait before exporting.")
 disks=[pathlib.Path.home(),root]
 if any(shutil.disk_usage(p).free<50*1024**3 for p in disks): raise RuntimeError("At least 50 GiB free disk space is required before exporting.")
 os.ftruncate(fd,0)
 os.write(fd,(json.dumps({"pid":os.getpid(),"launcher_pid":os.getppid(),"program":"Amu Creator export"})+"\n").encode())
 emit(ready=True)
 critical=0
 warned=False
 while not select.select([sys.stdin],[],[],3)[0]:
  try:
   level,_=memory()
   critical=critical+1 if level>=4 else 0
   if not warned and (critical>=2 or any(shutil.disk_usage(p).free<10*1024**3 for p in disks)):
    emit(cancel="Export stopped because memory pressure or free disk space reached its safety limit.")
    warned=True
  except Exception:
   if not warned:
    emit(cancel="Export stopped because resource monitoring became unavailable.")
    warned=True
 os.close(fd)
except Exception as error:
 emit(error=str(error))
 sys.exit(2)
`;

export function protectStudioAdapter(source: string): string {
  const BEFORE_TRY =
    "        try {\n          const { createRenderJob, executeRenderJob } = await loadStudioProducer();";
  const BEFORE_END = "      })();\n      inFlightRenders.set(abortController, run);";
  const BEFORE_JOB = "          const job = createRenderJob({";
  const BEFORE_RUN = "      const run = (async () => {\n        let renderJob;";

  for (const anchor of [BEFORE_TRY, BEFORE_END, BEFORE_JOB, BEFORE_RUN]) {
    if (source.split(anchor).length !== 2)
      throw new Error(
        "Amu render safety: incompatible HyperFrames Studio adapter. Export is disabled.",
      );
  }
  return source
    .replace(
      BEFORE_TRY,
      '        try {\n          await globalThis[Symbol.for("amu.render.acquire")](opts.project.dir, abortController, (reason) => { state.error = reason; abortController.abort(); });\n          const { createRenderJob, executeRenderJob } = await loadStudioProducer();',
    )
    .replace(BEFORE_JOB, BEFORE_JOB + "\n            workers: 1,")
    .replace(
      BEFORE_END,
      '      })().finally(() => globalThis[Symbol.for("amu.render.release")](abortController));\n      inFlightRenders.set(abortController, run);',
    );
}

const runtimeSource = String.raw`
const { registerHooks } = process.getBuiltinModule("node:module");
const { spawn } = process.getBuiltinModule("node:child_process");
const { fileURLToPath } = process.getBuiltinModule("node:url");
const protect = @@PROTECT@@;
const leases = new Map();
let installed = false;
const http = process.getBuiltinModule("node:http");
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function(event, ...args) {
  if (event === "request" && args[0].method === "POST" &&
      /^\/api\/projects\/[^/]+\/render\/?$/.test(new URL(args[0].url, "http://localhost").pathname) && !installed) {
    args[1].writeHead(503, {"Content-Type":"application/json"});
    args[1].end(JSON.stringify({error:"Amu render safety could not attach. Export is disabled."}));
    return true;
  }
  return originalEmit.call(this, event, ...args);
};
globalThis[Symbol.for("amu.render.acquire")] = (root, token, cancel) => new Promise((resolve, reject) => {
  const child = spawn("python3", ["-c", @@PROGRAM@@, root], { stdio: ["pipe", "pipe", "pipe"] });
  let ready = false, failed = false, released = false, pending = "";
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const fail = (message) => {
    clearTimeout(timer);
    if (ready && !released) cancel(message);
    else if (!ready && !failed) { failed = true; child.stdin.end(); reject(new Error(message)); }
  };
  const timer = setTimeout(() => fail("Resource preflight timed out; export was not started."), 30000);
  child.once("error", () => fail("Could not start the media safety check. Python 3 is required."));
  child.once("close", () => {
    clearTimeout(timer);
    resolveClosed();
    if (!released) fail("Media safety check stopped unexpectedly.");
  });
  child.stdin.on("error", () => {});
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => {
    pending += chunk.toString();
    if (pending.length > 16384) { fail("Invalid resource monitor response."); child.stdin.end(); return; }
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      let data;
      try { data = JSON.parse(line); } catch { fail("Invalid resource monitor response."); child.stdin.end(); return; }
      if (data.error) fail(String(data.error));
      else if (data.cancel) cancel(String(data.cancel));
      else if (data.ready && !ready) {
        clearTimeout(timer);
        if (failed || token.signal.aborted) { child.stdin.end(); fail("Export cancelled during preflight."); return; }
        ready = true;
        leases.set(token, () => { released = true; child.stdin.end(); return closed; });
        resolve();
      }
    }
  });
});
globalThis[Symbol.for("amu.render.release")] = (token) => {
  const release = leases.get(token);
  leases.delete(token);
  return release?.();
};
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith("file:") && /\/hyperframes\/dist\/studioServer-[^/]+\.js$/.test(fileURLToPath(url))) {
      const source = protect(String(result.source));
      installed = true;
      return { ...result, source };
    }
    return result;
  }
});
`;

/** Inert in npm's parent; the hook runs when the preview imports its adapter. */
export const renderSafetyNodeOptions = (inherited: string | undefined): string => {
  const source = runtimeSource
    .replace("@@PROTECT@@", protectStudioAdapter.toString())
    .replace("@@PROGRAM@@", JSON.stringify(renderLeaseProgram));
  const own = "--import=data:text/javascript;base64," + Buffer.from(source).toString("base64");
  return inherited?.trim() ? inherited.trim() + " " + own : own;
};
