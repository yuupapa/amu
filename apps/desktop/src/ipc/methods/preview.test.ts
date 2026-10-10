import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as BrowserImport from "../../preview/BrowserImport/BrowserImport.ts";
import * as PreviewIpc from "./preview.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

describe("preview IPC methods", () => {
  beforeEach(() => {
    fromPartition.mockClear();
  });

  it("does not access the Electron session while the module loads", async () => {
    await expect(import("./preview.ts")).resolves.toBeDefined();
    expect(fromPartition).not.toHaveBeenCalled();
  });

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("preserves lone surrogates without collapsing them to replacement characters", () => {
    const highSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\ud800");
    const lowSurrogate = PreviewIpc.resolvePartitionScope("environment", "profile-\udc00");
    const replacement = PreviewIpc.resolvePartitionScope("environment", "profile-�");

    expect(highSurrogate.scope).toBe('["environment","profile-\\ud800"]');
    expect(lowSurrogate.scope).toBe('["environment","profile-\\udc00"]');
    expect(highSurrogate.scope).not.toBe(lowSurrogate.scope);
    expect(highSurrogate.scope).not.toBe(replacement.scope);
    expect(lowSurrogate.scope).not.toBe(replacement.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });

  effectIt.effect("targets imports at the same partition tuple as the renderer", () => {
    const received: Array<Parameters<BrowserImport.BrowserImport["Service"]["importCookies"]>[0]> =
      [];
    const browserImport = BrowserImport.BrowserImport.of({
      listSources: Effect.succeed([]),
      importCookies: (input) =>
        Effect.sync(() => {
          received.push(input);
          return { imported: 0, skipped: 0, skippedDomains: [] };
        }),
    });
    const request = (environmentId: string, targetProfileId: string) =>
      PreviewIpc.importBrowserCookies.handler({
        environmentId,
        sourceId: "helium",
        sourceProfileDirectory: "Default",
        targetProfileId,
      });

    return Effect.gen(function* () {
      yield* request("a", "b");
      yield* request("a::b", DEFAULT_BROWSER_PROFILE_ID);

      expect(received[0]).toMatchObject(PreviewIpc.resolvePartitionScope("a", "b"));
      expect(received[1]).toMatchObject(
        PreviewIpc.resolvePartitionScope("a::b", DEFAULT_BROWSER_PROFILE_ID),
      );
      expect(received[0]?.namespace).toBe("profile");
      expect(received[1]?.namespace).toBeUndefined();
    }).pipe(Effect.provideService(BrowserImport.BrowserImport, browserImport));
  });

  effectIt.effect("rejects invalid webContents ids before resolving the preview service", () =>
    Effect.map(
      PreviewIpc.registerWebview
        .handler({ tabId: "tab-1", webContentsId: 0 })
        .pipe(Effect.provideService(PreviewManager.PreviewManager, null as never), Effect.exit),
      (exit) => {
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        expect(fromPartition).not.toHaveBeenCalled();
      },
    ),
  );

  effectIt.effect("accepts Creator calls only from the app window's renderer", () => {
    const calls: string[] = [];
    const record = (name: string, value: unknown) =>
      Effect.sync(() => {
        calls.push(name);
        return value;
      });
    const manager = {
      registerCreatorSession: () => record("register", { ok: true, epoch: 1, generation: 1 }),
      revokeCreatorSession: () => record("revoke", undefined),
      revokeAllCreatorSessions: () => record("revokeAll", undefined),
      isCreatorSessionCurrent: () => record("isCurrent", true),
      creatorApprove: () => record("approve", { ok: true, epoch: 1 }),
      pushCreatorState: () => record("pushState", true),
    } as unknown as PreviewManager.PreviewManager["Service"];
    const bindingId = "11111111-1111-4111-8111-111111111111";
    const proposalId = "33333333-3333-4333-8333-333333333333";
    const invocations = [
      [PreviewIpc.registerCreatorSession, { tabId: "tab", bindingId }],
      [PreviewIpc.revokeCreatorSession, { tabId: "tab" }],
      [PreviewIpc.revokeAllCreatorSessions, undefined],
      [PreviewIpc.isCreatorSessionCurrent, { tabId: "tab", generation: 1 }],
      [PreviewIpc.creatorApprove, { tabId: "tab", generation: 1, proposalId }],
      [PreviewIpc.pushCreatorState, { tabId: "tab", state: {} }],
    ] as const;

    return Effect.gen(function* () {
      for (const [method, payload] of invocations) {
        // A preview guest (its own webContents id) and a missing sender are refused.
        for (const event of [{ sender: { id: 42 } }, undefined]) {
          const exit = yield* Effect.exit(method.handler(payload, event));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            expect(Option.isSome(error) && error.value._tag).toBe(
              "CreatorIpcUnauthorizedSenderError",
            );
          }
        }
      }
      expect(calls).toEqual([]);
      for (const [method, payload] of invocations) {
        yield* method.handler(payload, { sender: { id: 7 } });
      }
      expect(calls).toEqual([
        "register",
        "revoke",
        "revokeAll",
        "isCurrent",
        "approve",
        "pushState",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents: { id: 7 } }),
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(PreviewManager.PreviewManager, manager),
        ),
      ),
    );
  });

  effectIt.effect("opens the Creator video picker only for the app window's renderer", () => {
    const picks: Array<ElectronDialog.ElectronDialogPickFilesInput> = [];
    const dialog = {
      pickFiles: (input: ElectronDialog.ElectronDialogPickFilesInput) =>
        Effect.sync(() => {
          picks.push(input);
          return ["/Users/me/Movies/review.mov"];
        }),
    } as unknown as ElectronDialog.ElectronDialog["Service"];
    return Effect.gen(function* () {
      for (const event of [{ sender: { id: 42 } }, undefined]) {
        const exit = yield* Effect.exit(PreviewIpc.pickCreatorVideo.handler(undefined, event));
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(picks).toEqual([]);
      const picked = yield* PreviewIpc.pickCreatorVideo.handler(undefined, { sender: { id: 7 } });
      expect(picked).toBe("/Users/me/Movies/review.mov");
      expect(picks).toHaveLength(1);
      expect(picks[0]?.multiple).toBe(false);
      expect(picks[0]?.filters.map((filter) => filter.name)).toEqual(["動画"]);
      expect(picks[0]?.filters.flatMap((filter) => filter.extensions)).toEqual([
        "mp4",
        "mov",
        "webm",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeedSome({ webContents: { id: 7 } }),
            focusedMainOrFirst: Effect.succeedNone,
          } as unknown as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(ElectronDialog.ElectronDialog, dialog),
        ),
      ),
    );
  });

  it("keeps the public automation status tab id limit", () => {
    const encode = Schema.encodeUnknownSync(PreviewAutomationStatus);
    const tabId = "t".repeat(129);

    expect(() =>
      encode({
        available: false,
        visible: true,
        tabId,
        url: null,
        title: null,
        loading: false,
      }),
    ).toThrow();
  });
});
