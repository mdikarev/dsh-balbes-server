/**
 * Живой текст хода задачи: буфер потока ответа модели для Telegram-канала.
 *
 * Единственный источник кадров — штатное событие движка
 * `agent/assistant-stream` (`@deepseek-ai/dsh-agent`): кадры `start`/`chunk`/
 * `end`, где чанк несёт `StreamChunk` (`@deepseek-ai/dsh-llm`). Поток здесь —
 * ПРЕДПРОСМОТР: канонический текст ответа остаётся durable `assistant/message`,
 * который суммирует раннер. Поэтому модуль чистый: ни I/O, ни бота, ни движка.
 */

/** Сколько символов держит буфер: длинный ответ не раздувает память. */
export const LIVE_ANSWER_LIMIT = 8 * 1024;

/** Сколько символов показывает витрина (сообщение в чате). */
export const ANSWER_VIEW_LIMIT = 3500;

/**
 * Минимальный срез кадра `agent/assistant-stream`. Пакет не импортирует типы
 * движка (как и остальные плагины): структурная форма зафиксирована движком, а
 * не этим пакетом.
 */
export interface AssistantFrameLike {
  type: string;
  chunk?: { type: string; text?: string };
}

export interface LiveAnswer {
  /** Открыть окно хода задачи: очистить текст и начать приём дельт. */
  startTurn(): void;
  /** Закрыть окно: приём выключен, текст очищен (осевший ход не читается). */
  endTurn(): void;
  /** Принять кадр: учитывается только `text-delta` открытого окна. */
  accept(frame: AssistantFrameLike): void;
  /**
   * Открыто ли окно хода задачи. Спека (`§Архитектура → Read-шов`) требует,
   * чтобы `answer()` отдавал живой текст только при открытом окне: закрытое
   * окно — это «вне хода» (`idle`) даже тогда, когда окно прогресса уже
   * передано служебному ходу p10g.
   */
  isOpen(): boolean;
  /** Накопленный хвост, не длиннее {@link LIVE_ANSWER_LIMIT}. */
  text(): string;
}

export function createLiveAnswer(): LiveAnswer {
  let open = false;
  let text = "";
  return {
    startTurn(): void {
      open = true;
      text = "";
    },
    endTurn(): void {
      open = false;
      text = "";
    },
    accept(frame: AssistantFrameLike): void {
      if (!open) return;
      if (frame.type !== "chunk") return;
      const chunk = frame.chunk;
      if (chunk === undefined || chunk.type !== "text-delta") return;
      const delta = chunk.text ?? "";
      if (delta === "") return;
      text += delta;
      if (text.length > LIVE_ANSWER_LIMIT) text = text.slice(text.length - LIVE_ANSWER_LIMIT);
    },
    isOpen(): boolean {
      return open;
    },
    text(): string {
      return text;
    }
  };
}

/** Хвостовое окно показа: последние `limit` символов текста. */
export function answerView(text: string, limit: number = ANSWER_VIEW_LIMIT): string {
  const size = Math.max(0, limit);
  return text.length <= size ? text : text.slice(text.length - size);
}
