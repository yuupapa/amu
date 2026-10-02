import { memo } from "react";
import { approvalPresentation } from "./approvalPresentation";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const Detail = approval.requestKind === "mcp-elicitation" ? "span" : "code";
  const presentation = approvalPresentation(approval);
  const fallbackLabel = presentation.title;
  const detailAriaLabel = presentation.detailLabel;
  const proseOriginal =
    approval.requestKind !== "command" &&
    approval.requestKind !== "file-read" &&
    presentation.detail === presentation.original &&
    !/[ぁ-んァ-ヶ一-龯]/.test(presentation.detail) &&
    /\s/.test(presentation.detail);

  return (
    <span
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">{fallbackLabel}</span>
        {approval.appName ? <span className="min-w-0 truncate">{approval.appName}</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{pendingCount}</span>
        ) : null}
      </span>
      <span className="text-xs text-foreground">
        {approval.requestKind === "command" ? "目的（コマンドからの推定）: " : "目的: "}
        {presentation.purpose}
      </span>
      {proseOriginal ? (
        <details className="w-full text-xs">
          <summary>対象・理由の原文を確認</summary>
          <pre className="whitespace-pre-wrap wrap-break-word">{presentation.original}</pre>
        </details>
      ) : (
        <Detail
          aria-label={detailAriaLabel}
          className={cn(
            "block max-h-20 w-full min-w-0 overflow-auto text-xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5",
            approval.requestKind === "mcp-elicitation"
              ? "whitespace-pre-wrap font-sans wrap-break-word"
              : "whitespace-pre font-mono",
          )}
          data-approval-detail="complete"
          tabIndex={0}
        >
          {presentation.detail || fallbackLabel}
        </Detail>
      )}
      {presentation.detail !== presentation.original && (
        <details className="w-full text-xs">
          <summary>提供元の原文を確認</summary>
          <pre className="whitespace-pre-wrap wrap-break-word">{presentation.original}</pre>
        </details>
      )}
    </span>
  );
});
