// @effect-diagnostics nodeBuiltinImport:off
/**
 * Opens a readable stream over an inherited file descriptor.
 *
 * `fs.createReadStream` reads on the libuv threadpool with a blocking read().
 * On a pipe or socket that the desktop keeps open for the life of the server,
 * that read never returns, and process exit then waits forever to join the
 * worker thread: the server hangs half-dead instead of exiting, so the desktop
 * never restarts it. Pipes and sockets are read through `net.Socket`, which
 * polls the descriptor on the event loop; regular files keep using fs.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

export function openFdReadStream(fd: number): NodeStream.Readable {
  const stats = NodeFS.fstatSync(fd);
  if (stats.isSocket() || stats.isFIFO()) {
    return new NodeNet.Socket({ fd, readable: true, writable: false });
  }
  return NodeFS.createReadStream("", { fd, autoClose: true });
}
