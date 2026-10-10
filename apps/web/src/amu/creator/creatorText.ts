/**
 * Japanese wording for Amu Creator refusals. Server errors arrive as
 * `CreatorDisabledError` or `CreatorOperationError { code, detail }`; anything
 * else (a dropped connection, an authorization error) gets a generic line.
 */

const readField = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
};

/** Shown whenever the page changed between the user's look and the server's check. */
export const CREATOR_PAGE_CHANGED = "ページが変わりました。開き直してから、もう一度送ってください";

/** A short sentence (at most 200 characters) explaining why the server refused. */
export function creatorErrorMessage(error: unknown): string {
  const tag = readField(error, "_tag");
  if (tag === "CreatorDisabledError") {
    return "Amu Creator がオフになっています（設定の「Amu Creator（試験版）」）";
  }
  if (tag !== "CreatorOperationError") {
    return "サーバーに届きませんでした。少し待ってから、もう一度お試しください";
  }
  const code = readField(error, "code");
  const detail = readField(error, "detail") ?? "";
  switch (code) {
    case "stale_epoch":
      return CREATOR_PAGE_CHANGED;
    case "stale_revision":
      return "ほかの変更と重なりました。表示を確かめて、もう一度お試しください";
    case "limit":
      if (detail === "rate_limited") return "少し間をあけてください";
      if (detail === "video_too_large") return "動画が大きすぎます（4GB まで）";
      if (detail.startsWith("preview_limit")) {
        return "同時に開ける Amu Creator は 3 つまでです。使っていないタブを閉じてください";
      }
      return "上限を超えたため保存できませんでした（コメント数・文字数・画像の容量）";
    case "not_found":
      if (detail === "path") return "選んだ場所が見つかりません";
      if (detail === "thread") return "スレッドが見つかりません";
      return "対象が見つかりません。表示を更新してください";
    case "invalid":
      return invalidMessage(detail);
    case "conflict":
      return "いまは変更できません（送信中か、確認待ちです）";
    case "unauthorized":
      if (detail === "desktop_session_only") return "この操作はデスクトップアプリだけでできます";
      if (detail === "not_in_workspace") return "プロジェクトの外は開けません";
      return "この操作は許可されていません。Amu Creator を開き直してください";
    case "unavailable":
      if (detail === "desktop_only") return "Amu Creator はデスクトップアプリだけで使えます";
      if (detail.startsWith("preview_")) return "HyperFrames を起動できませんでした";
      return "いまは使えません。少し待ってから、もう一度お試しください";
    default:
      return "処理できませんでした";
  }
}

function invalidMessage(detail: string): string {
  if (detail === "not_creator_project") {
    return "HyperFrames のプロジェクト（hyperframes.json のあるフォルダ）か、動画ファイル（.mp4 .mov .webm）を選んでください";
  }
  if (detail === "thread_archived") return "アーカイブしたスレッドでは開けません";
  if (detail === "path_not_absolute") return "場所を絶対パスで選んでください";
  if (detail === "video_changed")
    return "開いている途中で動画が置き換わりました。もう一度選んでください";
  if (detail.startsWith("outward_link")) {
    return "プロジェクトの外を指すリンクがあるため開けません";
  }
  if (detail.startsWith("too_many_entries") || detail.startsWith("timeout")) {
    return "プロジェクトのファイルが多すぎるため開けません";
  }
  if (detail.startsWith("unreadable"))
    return "プロジェクトの中に読めないファイルがあるため開けません";
  if (detail === "video_unreadable" || detail === "video_type") {
    return "この動画は開けません（.mp4 .mov .webm を選んでください）";
  }
  return "内容が正しくありません";
}
