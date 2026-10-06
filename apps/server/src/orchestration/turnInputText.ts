import type { OrchestrationMessage } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

/**
 * The text a user message becomes when it is sent to a provider: composer
 * context chips expanded, then trimmed. undefined when nothing is left.
 *
 * sendTurn and the handoff packet budget (design §6.5) both use this, so the
 * budget measures exactly what is sent.
 */
export function expandTurnInputText(
  message: Pick<OrchestrationMessage, "text" | "context">,
): string | undefined {
  const expanded = projectComposerContextForProvider({
    text: message.text,
    records: message.context?.records ?? [],
  }).trim();
  return expanded.length > 0 ? expanded : undefined;
}
