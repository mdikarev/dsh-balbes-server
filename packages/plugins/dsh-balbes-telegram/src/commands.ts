/**
 * The channel's command surface, in one place: the same table feeds the Bot API
 * registration (`setMyCommands`) and the text router, so the list a owner sees in
 * Telegram can never drift from what the bot actually answers. A text command
 * never reaches the agent — that invariant lives here.
 */

export type CommandName = "menu" | "status" | "ws" | "model" | "reset" | "stop" | "help";

export interface CommandSpec {
  command: CommandName;
  description: string;
}

/** Telegram command limits: lowercase latin name ≤ 32 chars, description ≤ 256. */
export const TELEGRAM_COMMANDS: CommandSpec[] = [
  { command: "menu", description: "Меню и состояние" },
  { command: "status", description: "Статус: воркспейс, модель, задача, очередь" },
  { command: "ws", description: "Сменить воркспейс" },
  { command: "model", description: "Сменить модель" },
  { command: "reset", description: "Сбросить контекст" },
  { command: "stop", description: "Остановить задачу" },
  { command: "help", description: "Справка" }
];

export const COMMAND_NAMES: ReadonlySet<string> = new Set<string>(TELEGRAM_COMMANDS.map((spec) => spec.command));

/**
 * Classify one text message: a known command, an unknown command ("unknown"), or
 * not a command at all (undefined — it is a task). `/start` is the Telegram
 * entry point and maps onto the menu.
 */
export function parseCommand(text: string): CommandName | "unknown" | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const bare = trimmed.slice(1).split("@", 1)[0]!.toLowerCase();
  if (bare === "start") return "menu";
  return COMMAND_NAMES.has(bare) ? (bare as CommandName) : "unknown";
}
