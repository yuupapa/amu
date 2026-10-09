// Stand-in for `hyperframes preview` in CreatorPreviewSupervisor tests.
// Usage: node fake-preview.mjs <mode> <root> <port>
// Modes: ready | silent | exit | ignore-sigterm | bad
// It starts one grandchild in its own process group and writes
// "<pid> <grandchildPid>" to <root>/pids-<port>.txt, so a test can check
// that the whole group is gone.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [mode, root, port] = process.argv.slice(2);

if (mode === "exit") {
  process.stderr.write("fake preview: giving up\n");
  process.exit(3);
}

// The grandchild gives up after 60 s on its own, so a broken group kill
// cannot leave it running for long.
const grandchild = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
  stdio: "ignore",
});
NodeFS.writeFileSync(NodePath.join(root, `pids-${port}.txt`), `${process.pid} ${grandchild.pid}`);

if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {});
}

setTimeout(() => process.exit(0), 60000);

if (mode === "ready" || mode === "ignore-sigterm") {
  process.stdout.write("\u001b[2mstarting\u001b[0m\n");
  setTimeout(() => {
    process.stdout.write(
      `  \u001b[1mStudio\u001b[22m    \u001b[36mhttp://localhost:${port}/#project/${NodePath.basename(root)}\u001b[39m\n`,
    );
  }, 50);
} else if (mode === "bad") {
  process.stdout.write(`  Studio    http://example.com:${port}/#project/x\n`);
}
