import { EnvironmentId, ThreadId, type CreatorBindingId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  unsubscribeEvents: vi.fn(),
  onCreatorEvent: vi.fn(),
  registerCreatorSession: vi.fn(async () => ({ ok: false as const, reason: "no_guest" })),
  command: async () => undefined,
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    onCreatorEvent: mocks.onCreatorEvent,
    onStateChange: () => () => undefined,
    registerCreatorSession: mocks.registerCreatorSession,
    pushCreatorState: async () => false,
  },
}));
vi.mock("~/state/creator", () => ({ creatorEnvironment: {} }));
vi.mock("~/state/use-atom-command", () => ({
  // Stable, like the real hook, so the session effect does not re-run every render.
  useAtomCommand: () => mocks.command,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.initial() }));
vi.mock("~/state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("~/previewStateStore", () => ({
  readThreadPreviewState: () => ({ sessions: { "server-tab": {} } }),
}));

import { useCreatorSession, type CreatorSessionState } from "./useCreatorSession";

const threadRef = {
  environmentId: EnvironmentId.make("env-popout"),
  threadId: ThreadId.make("thread-popout"),
};
const sessions = new Map<string, CreatorSessionState>();

function Holder({ name, passive }: { name: string; passive?: boolean }) {
  sessions.set(
    name,
    useCreatorSession({
      threadRef,
      serverTabId: "server-tab",
      runtimeTabId: "runtime-tab",
      bindingId: "11111111-1111-4111-8111-111111111111" as CreatorBindingId,
      enabled: true,
      ...(passive === undefined ? {} : { passive }),
    }),
  );
  return null;
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  sessions.clear();
  mocks.unsubscribeEvents.mockReset();
  mocks.onCreatorEvent.mockReset().mockReturnValue(mocks.unsubscribeEvents);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("useCreatorSession passive holders", () => {
  it("keeps a popped-out tab's bridge forwarding after its thread's view leaves", async () => {
    const render = (owner: boolean) => (
      <>
        {owner ? <Holder name="chat" /> : null}
        <Holder name="popout" passive />
      </>
    );
    await act(() => {
      renderer = create(render(true));
    });
    expect(mocks.onCreatorEvent).toHaveBeenCalledOnce();
    // The chat view's runner draws the sheet; the keep-alive never does.
    expect(sessions.get("chat")?.isOwner).toBe(true);
    expect(sessions.get("popout")?.isOwner).toBe(false);

    // Switching threads unmounts the chat view's runner; events still flow.
    await act(() => {
      renderer?.update(render(false));
    });
    expect(mocks.unsubscribeEvents).not.toHaveBeenCalled();
    expect(sessions.get("popout")?.isOwner).toBe(false);

    // Coming back, the chat view owns the sheet again even though it joined last.
    await act(() => {
      renderer?.update(render(true));
    });
    expect(mocks.onCreatorEvent).toHaveBeenCalledOnce();
    expect(sessions.get("chat")?.isOwner).toBe(true);

    await act(() => renderer?.unmount());
    renderer = undefined;
    expect(mocks.unsubscribeEvents).toHaveBeenCalledOnce();
  });
});
