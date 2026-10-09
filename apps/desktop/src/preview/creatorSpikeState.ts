// @effect-diagnostics nodeBuiltinImport:off - Throwaway stage-0 spike; plain node:crypto keeps it testable without an Effect runtime.
import { randomUUID } from "node:crypto";

import { SPIKE_LIMITS } from "./creatorSpikeGeometry.ts";

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
export type Pin = {
  id: string;
  number: number;
  timeSec: number;
  x: number;
  y: number;
  compositionFile: string | null;
  elementSelector: string | null;
  comment: string;
  revision: number;
  status: "draft" | "proposed" | "sent";
  shotPath: string | null;
};
export type Proposal = {
  id: string;
  pinIds: string[];
  snapshot: Array<Pick<Pin, "id" | "number" | "timeSec" | "comment" | "revision" | "shotPath">>;
  revisionKey: string;
};

const fail = <T>(reason: string): Result<T> => ({ ok: false, reason });
const finite01 = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const shortText = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && v.length <= SPIKE_LIMITS.maxLabel);

/** Throwaway stage-0 state for Amu Creator: ids, numbers and status are issued here, never by the guest. */
export const createSpikeState = (now: () => number) => {
  let generation = 0;
  let nextNumber = 1;
  const pins = new Map<string, Pin>();
  const proposals = new Map<string, Proposal>();
  const draftTimes: number[] = [];
  let lastProposeAt = Number.NEGATIVE_INFINITY;

  const rateOk = (): boolean => {
    const t = now();
    while (draftTimes.length > 0 && t - (draftTimes[0] ?? 0) >= 1000) draftTimes.shift();
    if (draftTimes.length >= 2) return false;
    draftTimes.push(t);
    return true;
  };
  const revisionKeyOf = (ids: string[]) =>
    ids.map((id) => `${id}:${pins.get(id)?.revision ?? -1}`).join("|");

  return {
    activate: (): number => {
      generation += 1;
      return generation;
    },
    navigationStarted: (): void => {
      generation += 1;
      proposals.clear();
    },
    pins: (): Pin[] => [...pins.values()],
    acceptDraft: (gen: number, raw: Record<string, unknown>): Result<Pin> => {
      if (gen !== generation) return fail("stale-generation");
      const { timeSec, x, y, compositionFile, elementSelector, comment } = raw;
      if (typeof timeSec !== "number" || !Number.isFinite(timeSec) || timeSec < 0) {
        return fail("bad-time");
      }
      if (!finite01(x) || !finite01(y)) return fail("bad-point");
      if (!shortText(compositionFile ?? null) || !shortText(elementSelector ?? null)) {
        return fail("bad-label");
      }
      if (typeof comment !== "string" || comment.length > SPIKE_LIMITS.maxComment) {
        return fail("bad-comment");
      }
      if (!rateOk()) return fail("rate-limited");
      const pin: Pin = {
        id: randomUUID(),
        number: nextNumber++,
        timeSec,
        x,
        y,
        compositionFile: (compositionFile as string | null | undefined) ?? null,
        elementSelector: (elementSelector as string | null | undefined) ?? null,
        comment,
        revision: 1,
        status: "draft",
        shotPath: null,
      };
      pins.set(pin.id, pin);
      return { ok: true, value: pin };
    },
    setShot: (pinId: string, shotPath: string): void => {
      const pin = pins.get(pinId);
      if (pin) pins.set(pinId, { ...pin, shotPath });
    },
    updateComment: (gen: number, pinId: string, comment: unknown): Result<Pin> => {
      if (gen !== generation) return fail("stale-generation");
      const pin = pins.get(pinId);
      if (!pin) return fail("no-pin");
      if (typeof comment !== "string" || comment.length > SPIKE_LIMITS.maxComment) {
        return fail("bad-comment");
      }
      if (!rateOk()) return fail("rate-limited");
      const next: Pin = {
        ...pin,
        comment,
        revision: pin.revision + 1,
        status: pin.status === "sent" ? "sent" : "draft",
      };
      pins.set(pinId, next);
      return { ok: true, value: next };
    },
    propose: (gen: number, pinIds: unknown): Result<Proposal> => {
      if (gen !== generation) return fail("stale-generation");
      if (
        !Array.isArray(pinIds) ||
        pinIds.length === 0 ||
        pinIds.length > SPIKE_LIMITS.maxPinsPerProposal
      ) {
        return fail("bad-count");
      }
      const ids = pinIds.filter((id): id is string => typeof id === "string" && pins.has(id));
      if (ids.length !== pinIds.length) return fail("unknown-pin");
      const t = now();
      if (t - lastProposeAt < 2000) return fail("rate-limited");
      lastProposeAt = t;
      const proposal: Proposal = {
        id: randomUUID(),
        pinIds: ids,
        snapshot: ids.map((id) => {
          const p = pins.get(id) as Pin;
          return {
            id: p.id,
            number: p.number,
            timeSec: p.timeSec,
            comment: p.comment,
            revision: p.revision,
            shotPath: p.shotPath,
          };
        }),
        revisionKey: revisionKeyOf(ids),
      };
      for (const id of ids) pins.set(id, { ...(pins.get(id) as Pin), status: "proposed" });
      proposals.set(proposal.id, proposal);
      return { ok: true, value: proposal };
    },
    confirm: (proposalId: string, revisionKey: string): Result<Proposal> => {
      const proposal = proposals.get(proposalId);
      if (!proposal) return fail("no-proposal");
      proposals.delete(proposalId);
      if (proposal.revisionKey !== revisionKey || revisionKeyOf(proposal.pinIds) !== revisionKey) {
        return fail("changed");
      }
      for (const id of proposal.pinIds) pins.set(id, { ...(pins.get(id) as Pin), status: "sent" });
      return { ok: true, value: proposal };
    },
  };
};
