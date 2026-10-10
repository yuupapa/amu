import type { CreatorProposal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readCreatorAttention, setCreatorAttention } from "./creatorAttention";

const attention = { proposal: {} as CreatorProposal, open: () => {} };

describe("setCreatorAttention", () => {
  it("keeps the owner's banner when another runner of the same tab clears", () => {
    const owner = Symbol("owner");
    const other = Symbol("other");
    setCreatorAttention("tab-shared", owner, attention);

    setCreatorAttention("tab-shared", other, null);
    expect(readCreatorAttention("tab-shared")).toBe(attention);

    setCreatorAttention("tab-shared", owner, null);
    expect(readCreatorAttention("tab-shared")).toBeNull();
  });

  it("lets a new owner take over the tab and ignores the old owner's clear", () => {
    const before = Symbol("before");
    const after = Symbol("after");
    const next = { proposal: {} as CreatorProposal, open: () => {} };
    setCreatorAttention("tab-handoff", before, attention);

    setCreatorAttention("tab-handoff", after, next);
    setCreatorAttention("tab-handoff", before, null);
    expect(readCreatorAttention("tab-handoff")).toBe(next);
  });
});
