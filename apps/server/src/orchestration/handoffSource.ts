import type {
  HandoffSourceRows,
  HandoffSourceUserRow,
} from "../persistence/Services/ProjectionThreadProviderSwitches.ts";
import {
  codePointLength,
  type HandoffChangedFile,
  type HandoffSource,
  type HandoffUserMessage,
} from "./CrossProviderHandoff.ts";

// Turns the bounded rows of readHandoffSource into the packet source
// (design §6.2–§6.4). Pure, so the packet text depends only on stored data.
// SQL lengths are code points, so the part SQL cut is counted in code points.

const cutBySql = (fullChars: number, text: string) =>
  Math.max(0, fullChars - codePointLength(text));

const toUserMessage = (row: HandoffSourceUserRow): HandoffUserMessage => ({
  turn: row.turn,
  text: row.text,
  omittedChars: cutBySql(row.fullChars, row.text),
  contextLabels: row.contextLabels,
});

function lastTurnOf(state: string | null): HandoffSource["state"]["lastTurn"] {
  switch (state) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
    default:
      // pending, running, or no turn yet: the state is not settled.
      return null;
  }
}

export function assembleHandoffSource(input: {
  readonly rows: HandoffSourceRows;
  readonly cwd: string | null;
  readonly fromDriver: string;
  readonly fromModel: string;
  /** boundaryTurnCount of the switch. */
  readonly fromTurnCount: number;
  /** Final diff from the turn-0 baseline to the latest checkpoint; null when unavailable. */
  readonly changes: ReadonlyArray<HandoffChangedFile> | null;
}): HandoffSource {
  const { rows } = input;
  const lastTurn = lastTurnOf(rows.lastTurnState);
  return {
    env: {
      cwd: input.cwd,
      branch: rows.thread?.branch ?? null,
      worktreePath: rows.thread?.worktreePath ?? null,
      runtimeMode: rows.thread?.runtimeMode ?? "unknown",
      interactionMode: rows.thread?.interactionMode ?? "unknown",
      fromDriver: input.fromDriver,
      fromModel: input.fromModel,
      fromTurnCount: input.fromTurnCount,
    },
    firstUserMessage: rows.firstUser === null ? null : toUserMessage(rows.firstUser),
    userMessages: rows.users.map(toUserMessage),
    omittedUserMessages: rows.omittedUsers,
    plan:
      rows.plan === null
        ? null
        : {
            markdown: rows.plan.markdown,
            implemented: rows.plan.implemented,
            omittedChars: cutBySql(rows.plan.fullChars, rows.plan.markdown),
          },
    changes: input.changes,
    state: {
      lastTurn,
      errorSummary: lastTurn === "failed" ? rows.lastError : null,
    },
    log: rows.log.map((row) =>
      row.kind === "assistant"
        ? {
            kind: "assistant" as const,
            turn: row.turn,
            model: row.model,
            text: row.text,
            omittedChars: cutBySql(row.fullChars, row.text),
          }
        : {
            kind: "tool" as const,
            turn: row.turn,
            summary: row.text,
            omittedChars: cutBySql(row.fullChars, row.text),
          },
    ),
    omittedAssistantMessages: rows.omittedAssistantMessages,
    omittedToolEntries: rows.omittedToolEntries,
  };
}
