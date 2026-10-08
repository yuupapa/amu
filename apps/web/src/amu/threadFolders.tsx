import { useEffect, useState, useSyncExternalStore } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { cn } from "../lib/utils";

/**
 * Amu: show a thread under another project in the sidebar (docs/user/thread-sidebar.md).
 * The thread keeps working where it always did; only its place in the list,
 * the project filter and the groups change. The choices live on the server
 * (apps/server/src/luna/ThreadFolders.ts), so every client shows the same.
 */

type Entries = Readonly<Record<string, string>>;
const PATH = "/api/amu/thread-folders";

let entries: Entries = {};
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

async function request(init?: { body: unknown }): Promise<Entries> {
  const bearer = await readDesktopPrimaryBearerToken();
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(PATH), {
    method: init ? "POST" : "GET",
    credentials: bearer ? "omit" : "include",
    headers: {
      ...(init ? { "Content-Type": "application/json" } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    ...(init ? { body: JSON.stringify(init.body) } : {}),
  });
  const answer = (await response.json()) as { result?: unknown; error?: string };
  if (!response.ok || answer.error) throw new Error(answer.error ?? "保存できませんでした。");
  const result = answer.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  return Object.fromEntries(
    Object.entries(result).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/** Reads the choices again (on start and when the window comes back to the front). */
export async function refreshThreadFolders(): Promise<void> {
  try {
    entries = await request();
    loaded = true;
    notify();
  } catch {
    // An older server has no such route; the sidebar shows threads as they are.
  }
}

/** Lists `threadId` under `projectId`, or under its own project again with null. */
export async function moveThreadInList(threadId: string, projectId: string | null): Promise<void> {
  entries = await request({ body: { threadId, projectId } });
  notify();
}

/** The choices as last read, for code outside React (Auto's folder context). */
export const currentThreadFolders = (): Entries => entries;

export function useThreadFolders(): Entries {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries,
    () => entries,
  );
  useEffect(() => {
    if (!loaded) void refreshThreadFolders();
    const onFocus = () => void refreshThreadFolders();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return value;
}

type ThreadLike = {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
};
type ProjectLike = { readonly id: string; readonly environmentId: string };

/**
 * The threads as the sidebar lists them: one with a chosen project shows
 * under it, when that project is still there on the same machine.
 */
export function applyThreadFolders<T extends ThreadLike>(
  threads: ReadonlyArray<T>,
  chosen: Entries,
  projects: ReadonlyArray<ProjectLike>,
): ReadonlyArray<T> {
  if (Object.keys(chosen).length === 0) return threads;
  const known = new Set(projects.map((project) => `${project.environmentId}:${project.id}`));
  let changed = false;
  const result = threads.map((thread) => {
    const projectId = chosen[thread.id];
    if (!projectId || projectId === thread.projectId) return thread;
    if (!known.has(`${thread.environmentId}:${projectId}`)) return thread;
    changed = true;
    return { ...thread, projectId } as T;
  });
  return changed ? result : threads;
}

type PickProject = {
  readonly id: string;
  readonly environmentId: string;
  readonly name: string;
  readonly workspaceRoot: string;
};

/** Picks the project a thread is listed under. */
export function ThreadFolderDialog(props: {
  thread: { id: string; title: string; environmentId: string; ownProjectId: string };
  shownUnder: string;
  projects: ReadonlyArray<PickProject>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(props.shownUnder);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = props.projects.filter(
    (project) => project.environmentId === props.thread.environmentId,
  );
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await moveThreadInList(
        props.thread.id,
        selected === props.thread.ownProjectId ? null : selected,
      );
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存できませんでした。");
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>一覧で表示するフォルダー</DialogTitle>
          <DialogDescription>
            「<span translate="no">{props.thread.title}</span>
            」を左の一覧で表示するプロジェクトを選びます。会話が作業するフォルダーは変わりません。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className="flex max-h-72 flex-col gap-1 overflow-y-auto"
            role="radiogroup"
            translate="no"
          >
            {choices.map((project) => (
              <button
                key={project.id}
                type="button"
                role="radio"
                aria-checked={selected === project.id}
                title={project.workspaceRoot}
                className={cn(
                  "flex flex-col items-start rounded-md border px-2.5 py-1.5 text-left",
                  selected === project.id
                    ? "border-foreground/60 bg-muted/40"
                    : "border-border/50 hover:bg-muted/20",
                )}
                onClick={() => setSelected(project.id)}
              >
                <span className="text-sm">
                  {project.name}
                  {project.id === props.thread.ownProjectId ? (
                    <span className="ml-1 text-xs text-muted-foreground" translate="yes">
                      （作業しているフォルダー）
                    </span>
                  ) : null}
                </span>
                <span className="w-full truncate text-2xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </button>
            ))}
          </div>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            やめる
          </Button>
          <Button disabled={saving || selected === props.shownUnder} onClick={() => void save()}>
            {saving ? "保存しています…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
