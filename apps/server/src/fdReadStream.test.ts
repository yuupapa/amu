// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { openFdReadStream } from "./fdReadStream.ts";

const readAll = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    stream.on("data", (chunk) => {
      text += chunk.toString();
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });

describe("openFdReadStream", () => {
  it("reads a regular file through fs", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fd-read-"));
    const file = NodePath.join(dir, "input.ndjson");
    NodeFS.writeFileSync(file, '{"a":1}\n');
    const stream = openFdReadStream(NodeFS.openSync(file, "r"));
    expect(stream).toBeInstanceOf(NodeFS.ReadStream);
    expect(await readAll(stream)).toBe('{"a":1}\n');
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("lets a never-ending pipe reader exit without blocking the threadpool", () => {
    // A child that holds the write end open forever and exits while still
    // reading must terminate promptly; with fs.createReadStream it hangs.
    const script = `
      const { openFdReadStream } = await import(${JSON.stringify(
        new URL("./fdReadStream.ts", import.meta.url).href,
      )});
      const stream = openFdReadStream(3);
      stream.on("data", () => {});
      setTimeout(() => process.exit(0), 200);
    `;
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { stdio: ["ignore", "ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
