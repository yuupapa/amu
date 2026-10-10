import { AuthOrchestrationOperateScope, type AuthEnvironmentScope } from "@t3tools/contracts";

import { isLoopbackRemoteAddress } from "../httpCors.ts";

/**
 * Whether a request comes from this machine's desktop app: its own session
 * (only the desktop-bootstrap grant issues that subject, and it carries over
 * to the bearer session) with the operate scope, on a loopback socket.
 * Tailscale serving forwards remote clients to loopback, so the address alone
 * would not do; a paired phone or browser has another subject. Never decided
 * from anything the client says about itself.
 */
export const isDesktopAppSession = (
  session: { readonly subject: string; readonly scopes: ReadonlyArray<AuthEnvironmentScope> },
  remoteAddress: string | undefined,
): boolean =>
  session.subject === "desktop-bootstrap" &&
  session.scopes.includes(AuthOrchestrationOperateScope) &&
  remoteAddress !== undefined &&
  isLoopbackRemoteAddress(remoteAddress);
