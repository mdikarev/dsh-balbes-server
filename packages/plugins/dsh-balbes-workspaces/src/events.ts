import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { homeDir, projectsRoot } from "./workspaces.js";
import { relDirOf } from "./tree.js";

export type ChangeEvent =
  | { kind: "fs"; scope: "home" | "project"; name?: string; path: string }
  | { kind: "list" };

/** Pure mapping from a watched root + raw relative path to a ChangeEvent. */
export function toChangeEvent(rootLabel: "home" | "projects", rel: string): ChangeEvent | null {
  const norm = (rel ?? "").replace(/\\/g, "/");
  const segments = norm.split("/").filter((s) => s !== "");
  if (rootLabel === "home") {
    return { kind: "fs", scope: "home", path: relDirOf(norm) };
  }
  if (segments.length === 0) return { kind: "list" }; // projects root itself changed
  const [name, ...rest] = segments;
  if (name === undefined || name.startsWith(".")) return null; // hidden bookkeeping under the projects root
  if (rest.length === 0) return { kind: "list" }; // project dir added/removed/renamed
  const restPath = rest.join("/");
  return { kind: "fs", scope: "project", name, path: relDirOf(restPath) };
}

const DEBOUNCE_MS = 120;
const REARM_MS = 30_000;

export interface ChangeHub {
  subscribe(fn: (e: ChangeEvent) => void): () => void;
  close(): void;
}

/** Lazy, debounced fs watcher over the agent home + projects root. */
export function createChangeHub(dshHome: string): ChangeHub {
  const listeners = new Set<(e: ChangeEvent) => void>();
  const pending = new Set<ChangeEvent>();
  let watchers: FSWatcher[] = [];
  let started = false;
  let prootArmed = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let rearm: ReturnType<typeof setInterval> | null = null;

  const emit = (e: ChangeEvent): void => {
    for (const fn of [...listeners]) {
      try {
        fn(e);
      } catch {
        // a broken listener must not kill the watcher loop
      }
    }
  };

  const flush = (): void => {
    debounce = null;
    for (const e of pending) emit(e);
    pending.clear();
  };

  const queue = (rootLabel: "home" | "projects", rel: string): void => {
    const e = toChangeEvent(rootLabel, rel);
    if (e === null) return;
    pending.add(e);
    if (debounce === null) debounce = setTimeout(flush, DEBOUNCE_MS);
  };

  const armHome = (): void => {
    try {
      const w = watch(homeDir(dshHome), { recursive: true }, (_eventType, filename) => {
        queue("home", typeof filename === "string" ? filename : "");
      });
      w.on("error", () => { /* home never vanishes in practice; ignore */ });
      watchers.push(w);
    } catch {
      /* home is ensured at boot; ignore */
    }
  };

  const armProjects = (): void => {
    if (prootArmed) return;
    const dir = projectsRoot(dshHome);
    if (!existsSync(dir)) return; // rearmed by the interval once it appears
    try {
      const w = watch(dir, { recursive: true }, (_eventType, filename) => {
        queue("projects", typeof filename === "string" ? filename : "");
      });
      w.on("error", () => {
        prootArmed = false; // root vanished (deleted): rearm when it returns
      });
      watchers.push(w);
      prootArmed = true;
    } catch {
      // e.g. ENOENT race with the interval check; retried on the next tick
    }
  };

  const start = (): void => {
    if (started) return;
    started = true;
    armHome();
    armProjects();
    rearm = setInterval(armProjects, REARM_MS);
  };

  const stop = (): void => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already closed */
      }
    }
    watchers = [];
    prootArmed = false;
    if (rearm !== null) clearInterval(rearm);
    rearm = null;
    if (debounce !== null) clearTimeout(debounce);
    debounce = null;
    pending.clear();
    started = false;
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      start();
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) stop();
      };
    },
    close() {
      listeners.clear();
      stop();
    }
  };
}
