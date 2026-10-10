import { ThreadId, WS_METHODS } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as CreatorOpen from "./CreatorOpen.ts";
import type * as CreatorSender from "./CreatorSender.ts";
import type * as CreatorService from "./CreatorService.ts";
import { makeCreatorWsHandlers } from "./creatorWsHandlers.ts";

const threadId = ThreadId.make("thread-ws-creator");

/** Services that must not be reached: every method dies. */
const unreachable = <S extends object>() =>
  new Proxy({} as S, {
    get: (_target, key) =>
      key === "then" ? undefined : () => Effect.die(`service reached: ${String(key)}`),
  });

const make = (desktopSession: boolean, opened: Array<CreatorOpen.CreatorOpenInput> = []) =>
  makeCreatorWsHandlers({
    desktopSession,
    creator: unreachable<CreatorService.CreatorService["Service"]>(),
    creatorSender: unreachable<CreatorSender.CreatorSender["Service"]>(),
    creatorOpen: {
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return {
            bindingId: "00000000-0000-4000-8000-000000000000",
            projectId: "0".repeat(32),
            epoch: 0,
            tabId: "tab-1",
          } as never;
        }),
    },
  });

it.effect("a paired-client session is refused on the whole Creator WS surface", () =>
  Effect.gen(function* () {
    const opened: Array<CreatorOpen.CreatorOpenInput> = [];
    const handlers = make(false, opened);
    const refusal = { _tag: "CreatorOperationError", code: "unauthorized" };
    const open = yield* Effect.flip(
      handlers[WS_METHODS.creatorOpenByUser]({ threadId, path: "/Users/me/promo" } as never),
    );
    expect(open).toMatchObject(refusal);
    expect(opened).toEqual([]);
    const effectMethods = [
      WS_METHODS.creatorSetEpoch,
      WS_METHODS.creatorSaveDraft,
      WS_METHODS.creatorUpdateComment,
      WS_METHODS.creatorSetPlace,
      WS_METHODS.creatorAttachShot,
      WS_METHODS.creatorDeleteComment,
      WS_METHODS.creatorPropose,
      WS_METHODS.creatorCancelProposal,
      WS_METHODS.creatorConfirmSend,
      WS_METHODS.creatorHaltSend,
      WS_METHODS.creatorAcknowledgeConflict,
      WS_METHODS.creatorConfirmByUser,
      WS_METHODS.creatorReadShot,
      WS_METHODS.creatorList,
    ] as const;
    for (const method of effectMethods) {
      const handler = handlers[method] as (
        input: never,
      ) => Effect.Effect<object | void, { readonly _tag: string }>;
      expect(yield* Effect.flip(handler({} as never)), method).toMatchObject(refusal);
    }
    const subscribed = yield* Stream.runCollect(
      handlers[WS_METHODS.creatorSubscribe]({} as never),
    ).pipe(Effect.flip);
    expect(subscribed).toMatchObject(refusal);
  }),
);

it.effect("the desktop app's session opens as the user", () =>
  Effect.gen(function* () {
    const opened: Array<CreatorOpen.CreatorOpenInput> = [];
    const handlers = make(true, opened);
    const result = yield* handlers[WS_METHODS.creatorOpenByUser]({
      threadId,
      path: "/Users/me/promo",
    } as never);
    expect(result.tabId).toBe("tab-1");
    expect(opened).toEqual([{ path: "/Users/me/promo", threadId, openedBy: "user" }]);
  }),
);
