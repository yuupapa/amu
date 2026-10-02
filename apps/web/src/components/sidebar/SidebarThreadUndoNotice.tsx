import { uiText, uiFormat } from "~/uiText";
import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {uiFormat("{0} threads: {1}", notice.count, uiText(notice.action))},{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? uiFormat("{0} to undo", shortcut) : uiText("Undo")}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
