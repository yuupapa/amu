// @effect-diagnostics nodeBuiltinImport:off
/**
 * The undici bundled with Node 24.21 (Electron 44) calls
 * `socket.setTypeOfService()` while writing an HTTP/1 request and does not
 * catch the error. On macOS the call can fail with EINVAL depending on socket
 * state (for example a loopback peer that is going away), and the throw lands
 * in a socket callback as an uncaught exception that takes the server down.
 *
 * Newer undici (8.x) treats QoS marking as best-effort and ignores the error.
 * Apply the same rule to every socket in this process.
 */
import * as NodeNet from "node:net";

const kGuarded = Symbol.for("amu.socketTypeOfServiceGuard");

type GuardableSocketPrototype = {
  setTypeOfService?: (this: NodeNet.Socket, tos: number) => NodeNet.Socket;
  [kGuarded]?: true;
};

export function installSocketTypeOfServiceGuard(
  prototype: GuardableSocketPrototype = NodeNet.Socket.prototype as GuardableSocketPrototype,
): void {
  const original = prototype.setTypeOfService;
  if (typeof original !== "function" || prototype[kGuarded]) return;
  prototype.setTypeOfService = function (this: NodeNet.Socket, tos: number) {
    try {
      return original.call(this, tos);
    } catch {
      return this;
    }
  };
  prototype[kGuarded] = true;
}
