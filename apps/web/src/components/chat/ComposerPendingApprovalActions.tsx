import { uiText } from "~/uiText";
import { approvalOptionPresentation } from "./approvalPresentation";
import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "取り消す" },
  { decision: "decline", label: "許可しない" },
  { decision: "acceptForSession", label: "このセッション中は許可" },
  { decision: "accept", label: "今回だけ許可" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const presentedOptions = options.map(approvalOptionPresentation);
  const primaryOptions = presentedOptions.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = presentedOptions.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <>
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={isResponding}
            aria-description={option.warning}
            title={
              option.originalLabel === option.label
                ? undefined
                : `提供元の選択肢: ${option.originalLabel}`
            }
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">
              {option.warning}
              {option.originalWarning !== option.warning && (
                <span className="mt-1 block">警告の原文: {option.originalWarning}</span>
              )}
            </TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={isResponding}
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label={uiText("More approval options")}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={isResponding}
                  aria-description={option.warning}
                  title={
                    option.originalLabel === option.label
                      ? undefined
                      : `提供元の選択肢: ${option.originalLabel}`
                  }
                  onClick={() => void onRespondToApproval(requestId, option.decision)}
                  variant="ghost"
                  className="mb-1 last:mb-0"
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">
                    {option.warning}
                    {option.originalWarning !== option.warning && (
                      <span className="mt-1 block">警告の原文: {option.originalWarning}</span>
                    )}
                  </TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
    </>
  );
});
