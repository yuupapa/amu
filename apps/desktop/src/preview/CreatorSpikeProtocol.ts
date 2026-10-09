export const CREATOR_SPIKE_ACTIVATE = "creator-spike:activate";
export const CREATOR_SPIKE_DRAFT = "creator-spike:draft";
export const CREATOR_SPIKE_UPDATE = "creator-spike:update";
export const CREATOR_SPIKE_PROPOSE = "creator-spike:propose";
export const CREATOR_SPIKE_STATE = "creator-spike:state";
export const creatorSpikeEnabled = (): boolean => process.env["AMU_CREATOR_SPIKE"] === "1";
export const CREATOR_SPIKE_LOCATE = "creator-spike:locate";
