import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { isDesktopAppSession } from "./desktopSession.ts";

const desktop = {
  subject: "desktop-bootstrap",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthPreviewOperateScope],
};

it("accepts only the desktop app's own session on a loopback socket", () => {
  expect(isDesktopAppSession(desktop, "127.0.0.1")).toBe(true);
  expect(isDesktopAppSession(desktop, "::1")).toBe(true);
  expect(isDesktopAppSession(desktop, "::ffff:127.0.0.1")).toBe(true);
});

it("refuses a paired client even on loopback (Tailscale serving forwards to loopback)", () => {
  expect(isDesktopAppSession({ ...desktop, subject: "one-time-token" }, "127.0.0.1")).toBe(false);
  expect(isDesktopAppSession({ ...desktop, subject: "pairing:phone" }, "127.0.0.1")).toBe(false);
});

it("refuses the desktop subject from another address, an unknown peer, or without operate", () => {
  expect(isDesktopAppSession(desktop, "100.64.0.7")).toBe(false);
  expect(isDesktopAppSession(desktop, undefined)).toBe(false);
  expect(isDesktopAppSession({ ...desktop, scopes: [AuthPreviewOperateScope] }, "127.0.0.1")).toBe(
    false,
  );
});
