import type { ProviderApprovalOption } from "@t3tools/contracts";
import type { PendingApproval } from "../../session-logic";

const kinds = {
  command: [
    "コマンド実行の承認",
    "実行するコマンド",
    "表示されたコマンドを実行するための許可です。",
  ],
  "file-read": [
    "ファイル読み取りの承認",
    "読み取るファイル",
    "表示されたファイルを読み取るための許可です。",
  ],
  "file-change": [
    "ファイル変更の承認",
    "変更の対象・理由",
    "表示された範囲でファイルを作成・変更するための許可です。",
  ],
  permission: [
    "追加アクセスの承認",
    "アクセスの対象・理由",
    "現在の実行制限を越えるアクセスの許可です。対象と範囲を確認してください。",
  ],
  "mcp-elicitation": [
    "アプリ接続の承認",
    "接続の対象・理由",
    "外部アプリやサービスへの接続・アクセスを許可する確認です。",
  ],
} as const;

export function approvalPresentation(approval: PendingApproval) {
  const [title, detailLabel, defaultPurpose] = kinds[approval.requestKind];
  const detail = approval.detail ?? "";
  let purpose: string = defaultPurpose;
  if (approval.requestKind === "command") {
    if (/\b(?:test|pytest|vitest|jest)\b/i.test(detail))
      purpose = "テストを実行し、変更後の動作を確認するための許可です。";
    else if (/\b(?:typecheck|tsc|tsgo)\b/i.test(detail))
      purpose = "型チェックを実行し、コードの型の不整合を確認するための許可です。";
    else if (/\b(?:build|compile)\b/i.test(detail))
      purpose = "ビルドを実行し、アプリの成果物を作成・確認するための許可です。";
    else if (/\b(?:install|add|download|curl|wget)\b/i.test(detail))
      purpose =
        "取得・インストールの操作を実行するための許可です。通信先と変更される場所を確認してください。";
  }
  // Commands and paths must remain exact. Only recognized prose is translated.
  const translatedDetail =
    approval.requestKind === "command" || approval.requestKind === "file-read"
      ? detail
      : detail
          .replace(
            /^Allow ChatGPT to (?:use|access) (.+)\?$/,
            "ChatGPTが $1 にアクセスすることを許可しますか？",
          )
          .replace(/the selected application/g, "選択したアプリ")
          .replace(/^Access:\s*/, "アクセス対象: ")
          .replace(/outside (?:of )?(?:the )?workspace/gi, "作業フォルダーの外側")
          .replace(/^Write access to /, "書き込み対象: ")
          .replace(/^Read access to /, "読み取り対象: ");
  return { title, detailLabel, purpose, detail: translatedDetail, original: detail };
}

export function approvalOptionPresentation(option: ProviderApprovalOption) {
  const labels = {
    accept: "今回だけ許可",
    acceptForSession: "このセッション中は許可",
    acceptAlways: "今後も許可",
    decline: "許可しない",
    cancel: "取り消す",
  } as const;
  // Preserve a provider's Japanese scope qualifier; unknown English text stays available as the original.
  const label = /[ぁ-んァ-ヶ一-龯]/.test(option.label) ? option.label : labels[option.decision];
  const warning = option.warning
    ? /[ぁ-んァ-ヶ一-龯]/.test(option.warning)
      ? option.warning
      : /(?:prompt injection|untrusted|malicious)/i.test(option.warning)
        ? "外部の内容に、指示の乗っ取りにつながる可能性があると実行サービスが警告しています。"
        : "この許可について実行サービスから警告があります。警告の原文を確認してください。"
    : undefined;
  return {
    ...option,
    label,
    warning,
    originalLabel: option.label,
    originalWarning: option.warning,
  };
}
