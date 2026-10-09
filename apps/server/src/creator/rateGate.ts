/**
 * Sliding-window rate gate for Creator operations. Each gate owns its own
 * timestamps (no module state), so tests and services pass their own instance.
 * The caller supplies the key (the Creator project id).
 */
import { CREATOR_LIMITS } from "@t3tools/contracts";

export type RateKind = "draft" | "propose";

export interface RateGate {
  /** Returns true and records the call, or false when the window is full. */
  readonly allow: (key: string, kind: RateKind, nowMs: number) => boolean;
}

const RULES: Readonly<Record<RateKind, { readonly max: number; readonly windowMs: number }>> = {
  draft: { max: CREATOR_LIMITS.commentRateMax, windowMs: CREATOR_LIMITS.commentRateWindowMs },
  propose: { max: 1, windowMs: CREATOR_LIMITS.proposeIntervalMs },
};

export const makeRateGate = (): RateGate => {
  const calls = new Map<string, number[]>();
  return {
    allow: (key, kind, nowMs) => {
      const rule = RULES[kind];
      const mapKey = `${kind}\u0000${key}`;
      const recent = (calls.get(mapKey) ?? []).filter((at) => nowMs - at < rule.windowMs);
      if (recent.length >= rule.max) {
        calls.set(mapKey, recent);
        return false;
      }
      recent.push(nowMs);
      calls.set(mapKey, recent);
      return true;
    },
  };
};
