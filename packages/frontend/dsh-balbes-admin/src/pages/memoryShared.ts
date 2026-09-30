import type { MemoryScope, MemoryType } from "dsh-balbes-contracts";

export const MEMORY_TYPES: MemoryType[] = ["fact", "preference", "decision", "note"];

export const TYPE_LABELS: Record<MemoryType, string> = {
  fact: "факт",
  preference: "предпочтение",
  decision: "решение",
  note: "заметка"
};

export type MemoryLevel = MemoryScope;
/** A concrete level, or the «Все» pseudo-level listing every scope. */
export type LevelSelection = MemoryLevel | { kind: "all" };

export function levelKey(level: LevelSelection): string {
  if (level.kind === "all") return "all";
  return level.kind === "global" ? "global" : "project:" + level.name;
}

export function levelLabel(level: MemoryLevel): string {
  return level.kind === "global" ? "Дом" : level.name;
}

/** Parses a concrete level option value; «Все» is not a concrete level. */
export function parseScope(value: string): MemoryLevel {
  return value === "global" ? { kind: "global" } : { kind: "project", name: value.slice("project:".length) };
}

export function parseTags(raw: string): string[] {
  return raw.split(/[\s,]+/).map((tag) => tag.trim()).filter((tag) => tag !== "");
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}
