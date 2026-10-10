import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewRevealActions,
  previewRevealBaseline,
  revealableSessions,
  type RevealSurface,
} from "./previewAutoReveal";

const session = (
  tabId: string,
  overrides: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot => ({
  threadId: "thread-1" as PreviewSessionSnapshot["threadId"],
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...overrides,
});

const creatorTab = (tabId: string, overrides: Partial<PreviewSessionSnapshot> = {}) =>
  session(tabId, {
    reveal: true,
    creator: {
      bindingId: "11111111-1111-4111-8111-111111111111" as never,
      label: "promo",
    },
    ...overrides,
  });

const agentServerTab = (tabId: string, revealId: string, force = false) =>
  session(tabId, { runtime: "server", reveal: true, revealRequest: { id: revealId, force } });

const surfaceFor = (tabId: string): RevealSurface => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});

/** Runs one effect pass the way ChatView does: baseline from before, sessions now. */
const pass = (
  before: PreviewSessionSnapshot[],
  now: PreviewSessionSnapshot[],
  options: { autoShow: boolean; surfaces?: RevealSurface[] },
) =>
  previewRevealActions({
    sessions: now,
    previous: previewRevealBaseline(before),
    autoShowFloating: options.autoShow,
    surfaces: options.surfaces ?? [],
  });

describe("revealableSessions", () => {
  const desktopTab = creatorTab("creator");
  const serverTab = agentServerTab("agent", "r1");

  it("keeps server tabs only where the environment hosts them, desktop tabs only in Electron", () => {
    const sessions = [desktopTab, serverTab];
    expect(revealableSessions(sessions, { server: true, desktop: true })).toEqual(sessions);
    expect(revealableSessions(sessions, { server: true, desktop: false })).toEqual([serverTab]);
    expect(revealableSessions(sessions, { server: false, desktop: true })).toEqual([desktopTab]);
  });
});

describe("previewRevealActions", () => {
  it("floats a Creator tab an agent opened, like an agent browser tab (auto-show on)", () => {
    // The bug: Creator tabs are desktop tabs, which the reveal pass used to skip.
    expect(pass([], [creatorTab("creator")], { autoShow: true })).toEqual([
      { kind: "float", tabId: "creator" },
    ]);
    expect(pass([], [agentServerTab("agent", "r1")], { autoShow: true })).toEqual([
      { kind: "float", tabId: "agent" },
    ]);
  });

  it("opens a Creator tab in the right panel when auto-show is off", () => {
    expect(pass([], [creatorTab("creator")], { autoShow: false })).toEqual([
      { kind: "panel", tabId: "creator" },
    ]);
    // An ordinary agent browser tab stays quiet unless forced.
    expect(pass([], [agentServerTab("agent", "r1")], { autoShow: false })).toEqual([]);
    expect(pass([], [agentServerTab("agent", "r1", true)], { autoShow: false })).toEqual([
      { kind: "float", tabId: "agent" },
    ]);
  });

  it("reveals only once, and never tabs that were there before (reloads)", () => {
    const tab = creatorTab("creator");
    expect(pass([tab], [tab], { autoShow: true })).toEqual([]);
    expect(pass([tab], [tab], { autoShow: false })).toEqual([]);
  });

  it("ignores tabs nobody asked to show (the user's own Creator open, plain tabs)", () => {
    const userOpened = creatorTab("creator", { reveal: undefined });
    expect(pass([], [userOpened, session("plain")], { autoShow: true })).toEqual([]);
    expect(pass([], [userOpened], { autoShow: false })).toEqual([]);
  });

  it("brings a forced reveal of an existing panel tab to the front", () => {
    const before = agentServerTab("agent", "r1");
    const after = agentServerTab("agent", "r2", true);
    expect(pass([before], [after], { autoShow: true, surfaces: [surfaceFor("agent")] })).toEqual([
      { kind: "activate", surfaceId: "browser:agent" },
    ]);
    // Not forced and already a panel tab: left where it is.
    const quiet = agentServerTab("agent", "r3");
    expect(pass([after], [quiet], { autoShow: true, surfaces: [surfaceFor("agent")] })).toEqual([]);
  });
});
