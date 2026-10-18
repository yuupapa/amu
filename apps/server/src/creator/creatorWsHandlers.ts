/**
 * The Creator WS RPC handlers. In stage 1 the whole Creator surface belongs to
 * this machine's desktop app (`isDesktopAppSession`, decided at the WS upgrade
 * from the session and the socket peer, never from what the client says): a
 * paired phone or remote browser holds `preview:operate` too, but must not open
 * local paths, bind tabs or send comments.
 */
import {
  CreatorOperationError,
  GalleryOperationError,
  WS_METHODS,
  type CreatorAcknowledgeConflictInput,
  type CreatorAttachShotInput,
  type CreatorCancelProposalInput,
  type CreatorConfirmByUserInput,
  type CreatorConfirmSendInput,
  type CreatorDeleteCommentInput,
  type CreatorHaltSendInput,
  type CreatorListInput,
  type CreatorOpenByUserInput,
  type CreatorProposeInput,
  type CreatorReadShotInput,
  type CreatorSaveDraftInput,
  type CreatorSetEpochInput,
  type CreatorSetPlaceInput,
  type CreatorSubscribeInput,
  type CreatorUpdateCommentInput,
  type GalleryOpenByUserInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as CreatorOpen from "./CreatorOpen.ts";
import type * as CreatorSender from "./CreatorSender.ts";
import type * as CreatorService from "./CreatorService.ts";
import type * as GalleryOpen from "../gallery/GalleryOpen.ts";

export interface CreatorWsHandlerDeps {
  /** The WS session is the desktop app's own (`isDesktopAppSession`). */
  readonly desktopSession: boolean;
  readonly creator: CreatorService.CreatorService["Service"];
  readonly creatorSender: CreatorSender.CreatorSender["Service"];
  readonly creatorOpen: CreatorOpen.CreatorOpen["Service"];
  readonly galleryOpen: GalleryOpen.GalleryOpen["Service"];
}

const desktopOnly = new CreatorOperationError({
  code: "unauthorized",
  detail: "desktop_session_only",
});

export const makeCreatorWsHandlers = ({
  desktopSession,
  creator,
  creatorSender,
  creatorOpen,
  galleryOpen,
}: CreatorWsHandlerDeps) => {
  const gate = <A, E, R>(run: () => Effect.Effect<A, E, R>) =>
    desktopSession ? run() : Effect.fail(desktopOnly);
  return {
    // The user's own pick (desktop folder or file picker), so outside the workspace is fine.
    [WS_METHODS.creatorOpenByUser]: (input: CreatorOpenByUserInput) =>
      gate(() =>
        creatorOpen.open({ path: input.path, threadId: input.threadId, openedBy: "user" }),
      ),
    [WS_METHODS.galleryOpenByUser]: (input: GalleryOpenByUserInput) =>
      desktopSession
        ? galleryOpen.open({ threadId: input.threadId, openedBy: "user" })
        : Effect.fail(
            new GalleryOperationError({ code: "unauthorized", detail: "desktop_session_only" }),
          ),
    [WS_METHODS.creatorSetEpoch]: (input: CreatorSetEpochInput) =>
      gate(() => creator.setEpoch(input).pipe(Effect.asVoid)),
    [WS_METHODS.creatorSaveDraft]: (input: CreatorSaveDraftInput) =>
      gate(() => creator.saveDraft(input)),
    [WS_METHODS.creatorUpdateComment]: (input: CreatorUpdateCommentInput) =>
      gate(() => creator.updateComment(input)),
    [WS_METHODS.creatorSetPlace]: (input: CreatorSetPlaceInput) =>
      gate(() => creator.setPlace(input)),
    [WS_METHODS.creatorAttachShot]: (input: CreatorAttachShotInput) =>
      gate(() => creator.attachShot(input)),
    [WS_METHODS.creatorDeleteComment]: (input: CreatorDeleteCommentInput) =>
      gate(() => creator.deleteComment(input)),
    [WS_METHODS.creatorPropose]: (input: CreatorProposeInput) => gate(() => creator.propose(input)),
    [WS_METHODS.creatorCancelProposal]: (input: CreatorCancelProposalInput) =>
      gate(() => creator.cancelProposal(input)),
    [WS_METHODS.creatorConfirmSend]: (input: CreatorConfirmSendInput) =>
      gate(() => creatorSender.confirmSend(input)),
    [WS_METHODS.creatorHaltSend]: (input: CreatorHaltSendInput) =>
      gate(() => creatorSender.haltSend(input)),
    [WS_METHODS.creatorAcknowledgeConflict]: (input: CreatorAcknowledgeConflictInput) =>
      gate(() => creatorSender.acknowledgeConflict(input)),
    [WS_METHODS.creatorConfirmByUser]: (input: CreatorConfirmByUserInput) =>
      gate(() => creator.confirmByUser(input)),
    [WS_METHODS.creatorReadShot]: (input: CreatorReadShotInput) =>
      gate(() => creator.readShot(input)),
    [WS_METHODS.creatorList]: (input: CreatorListInput) => gate(() => creator.list(input)),
    // Starting a subscription also settles sends left open (in the background).
    [WS_METHODS.creatorSubscribe]: (input: CreatorSubscribeInput) =>
      desktopSession
        ? Stream.unwrap(
            creatorSender
              .reconcileInBackground(input.bindingId)
              .pipe(Effect.as(creator.changes(input))),
          )
        : Stream.fail(desktopOnly),
  } as const;
};
