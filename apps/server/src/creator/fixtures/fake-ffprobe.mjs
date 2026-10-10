// Stand-in for ffprobe in reviewProject tests.
// Usage: node fake-ffprobe.mjs <mode> <pidFile> ...ffprobe args
// Modes: ok | slow | flood | fail | garbage | zero | long
// It also writes the ffprobe arguments it got, one per line, to <pidFile>.args.
import * as NodeFS from "node:fs";

const [mode, pidFile] = process.argv.slice(2);
NodeFS.writeFileSync(pidFile, String(process.pid));
NodeFS.writeFileSync(`${pidFile}.args`, process.argv.slice(4).join("\n"));

if (mode === "ok") {
  process.stdout.write(JSON.stringify({ format: { duration: "12.500000" } }));
} else if (mode === "slow") {
  setTimeout(() => {}, 60_000);
} else if (mode === "flood") {
  const chunk = "x".repeat(16 * 1024);
  const write = () => {
    while (process.stdout.write(chunk)) {}
    process.stdout.once("drain", write);
  };
  write();
  setTimeout(() => {}, 60_000);
} else if (mode === "zero") {
  process.stdout.write(JSON.stringify({ format: { duration: "0.000000" } }));
} else if (mode === "long") {
  process.stdout.write(JSON.stringify({ format: { duration: "21600.5" } }));
} else if (mode === "fail") {
  process.stderr.write("No such file\n");
  process.exit(1);
} else {
  process.stdout.write("{ not json");
}
