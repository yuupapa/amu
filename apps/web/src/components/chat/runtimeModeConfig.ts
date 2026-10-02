import { uiText } from "~/uiText";
import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: uiText("Supervised"),
    description: uiText("Ask before commands and file changes."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: uiText("Auto-accept edits"),
    description: uiText("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: uiText("Auto"),
    description:
      "対応する実行サービスが通常の操作を自動判断します。追加の権限やアプリ接続では確認が残ります。",
    icon: SparklesIcon,
  },
  "full-access": {
    label: uiText("Full access"),
    description:
      "この会話の実行サービスにコマンド実行と編集を許可します。macOSや外側の実行環境の承認規則は変わりません。",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
