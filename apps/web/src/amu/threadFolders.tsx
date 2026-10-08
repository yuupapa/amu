import { useEffect, useRef, useState, useSyncExternalStore } from "react";

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
/** The server's revision of `entries`; an older answer is dropped. */
let revision = -1;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

type Answer = { entries: Entries; revision: number };

async function request(init?: { body: unknown }): Promise<Answer> {
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
  const answer = (await response.json()) as {
    result?: unknown;
    revision?: unknown;
    error?: string;
  };
  if (!response.ok || answer.error) throw new Error(answer.error ?? "保存できませんでした。");
  const result = answer.result;
  const read =
    !result || typeof result !== "object" || Array.isArray(result)
      ? {}
      : Object.fromEntries(
          Object.entries(result).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
  return { entries: read, revision: typeof answer.revision === "number" ? answer.revision : 0 };
}

/**
 * Takes an answer unless a newer one is already in: answers can arrive out
 * of order (two saves, or a read that crossed a save here or on another device).
 */
export function acceptAnswer(answer: Answer): boolean {
  if (answer.revision < revision) return false;
  revision = answer.revision;
  entries = answer.entries;
  loaded = true;
  notify();
  return true;
}

/** Reads the choices again (on start and when the window comes back to the front). */
export async function refreshThreadFolders(): Promise<void> {
  try {
    acceptAnswer(await request());
  } catch {
    // An older server has no such route; the sidebar shows threads as they are.
  }
}

/** Lists `threadId` under `projectId`, or under its own project again with null. */
export async function moveThreadInList(threadId: string, projectId: string | null): Promise<void> {
  acceptAnswer(await request({ body: { threadId, projectId } }));
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
 * The project a thread is listed under: the chosen one when it is still there
 * on the same machine, else its own. The choices are this Mac's (the primary
 * environment's), so threads of other machines are always listed as they are.
 */
export function listedProjectIdLookup<P extends string>(
  chosen: Entries,
  projects: ReadonlyArray<{ readonly id: P; readonly environmentId: string }>,
  primaryEnvironmentId: string | null,
): (thread: { readonly id: string; readonly environmentId: string; readonly projectId: P }) => P {
  if (Object.keys(chosen).length === 0 || primaryEnvironmentId === null)
    return (thread) => thread.projectId;
  const known = new Map<string, P>();
  for (const project of projects)
    if (project.environmentId === primaryEnvironmentId) known.set(project.id, project.id);
  return (thread) => {
    if (thread.environmentId !== primaryEnvironmentId) return thread.projectId;
    const chosenId = chosen[thread.id];
    return (chosenId !== undefined ? known.get(chosenId) : undefined) ?? thread.projectId;
  };
}

/** The threads with the project they are listed under, for counting work (Auto's folders). */
export function applyThreadFolders<T extends ThreadLike>(
  threads: ReadonlyArray<T>,
  chosen: Entries,
  projects: ReadonlyArray<ProjectLike>,
  primaryEnvironmentId: string | null,
): ReadonlyArray<T> {
  const listed = listedProjectIdLookup<string>(chosen, projects, primaryEnvironmentId);
  let changed = false;
  const result = threads.map((thread) => {
    const projectId = listed(thread);
    if (projectId === thread.projectId) return thread;
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
  // A save that finishes after this dialog was closed must not close another one.
  const open = useRef(true);
  useEffect(
    () => () => {
      open.current = false;
    },
    [],
  );
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
      if (open.current) props.onClose();
    } catch (cause) {
      if (!open.current) return;
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
