import { uiLanguage } from "../uiText";

/**
 * Japanese for the reasons apps/server/src/storageCleanup.ts gives per cleanup
 * result. The server sends English sentences; they are mapped here instead of
 * in the page dictionary because "Open terminal" means "a terminal is open"
 * here, while the dictionary has it as the button "ターミナルを開く".
 * Reasons not listed (Git errors) stay as the server wrote them.
 */
export const CLEANUP_REASONS_JA: Readonly<Record<string, string>> = {
  // Kept
  "No rules apply": "当てはまる整理のルールがありません",
  "Shared by {0} threads": "{0} 件のスレッドで共有しています",
  "Project is unavailable": "プロジェクトを確認できません",
  "Thread is running or has pending work": "スレッドが実行中か、残っている作業があります",
  "Open terminal": "ターミナルが開いています",
  "Worktree is a symbolic link": "作業ツリーがシンボリックリンクです",
  "Outside the managed worktree folder": "管理している作業ツリーのフォルダーの外にあります",
  "Contains a project checkout": "プロジェクトのチェックアウトを含んでいます",
  "Not a linked worktree": "リンクした作業ツリーではありません",
  "Repository or branch changed": "リポジトリかブランチが変わりました",
  "Default branch is unavailable": "既定のブランチを確認できません",
  "Inactive for {0} of {1} days": "{0} 日使われていません（{1} 日で削除）",
  "Not merged": "マージされていません",
  "Has commits beyond the default branch": "既定のブランチにないコミットがあります",
  "Thread or cleanup settings changed since check":
    "確認のあとで、スレッドか整理の設定が変わりました",
  "Thread deletion is still pending": "スレッドの削除がまだ終わっていません",
  "Thread activity or shared worktree changed since check":
    "確認のあとで、スレッドの動きか共有している作業ツリーが変わりました",
  "Provider session is still open": "プロバイダーのセッションがまだ開いています",
  "Repository or branch changed since check": "確認のあとで、リポジトリかブランチが変わりました",
  "Commit changed since check": "確認のあとで、コミットが変わりました",
  "Settings changed since check": "確認のあとで、設定が変わりました",
  // Local changes
  "Local changes exceed the inspection limit": "ローカルの変更が多すぎて確認しきれません",
  "Has uncommitted changes ({0} file)": "コミットしていない変更があります（{0} ファイル）",
  "Has uncommitted changes ({0} files)": "コミットしていない変更があります（{0} ファイル）",
  "Ignored files exceed the inspection limit": "Git が無視するファイルが多すぎて確認しきれません",
  "Has ignored files ({0})": "Git が無視するファイルがあります（{0}）",
  // Removed
  "Thread was deleted": "スレッドが削除されました",
  "Inactive for {0} days": "{0} 日使われていませんでした",
  "No commits beyond the default branch": "既定のブランチにないコミットはありませんでした",
  "Pull request was merged": "プルリクエストがマージされました",
  // Logs and browser artifacts
  "No expired files": "期限切れのファイルはありません",
  "Removed {0} browser artifacts": "ブラウザーの成果物を {0} 件削除しました",
  "Removed {0} rotated logs": "ローテーションしたログを {0} 件削除しました",
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RULES = Object.entries(CLEANUP_REASONS_JA).map(([english, japanese]) => {
  const pattern = new RegExp(
    `^${english
      .split(/(\{\d\})/)
      .map((part) => (/^\{\d\}$/.test(part) ? "(.+)" : escapeRegExp(part)))
      .join("")}$`,
    "s",
  );
  return { pattern, japanese };
});

export function translateCleanupReason(reason: string): string {
  if (uiLanguage === "en") return reason;
  for (const { pattern, japanese } of RULES) {
    const match = pattern.exec(reason);
    if (match !== null) {
      return japanese.replace(/\{(\d)\}/g, (_, n: string) => match[Number(n) + 1] ?? "");
    }
  }
  return reason;
}
