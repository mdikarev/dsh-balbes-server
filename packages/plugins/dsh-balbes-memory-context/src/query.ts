/** Максимум поисковых термов, взятых из одной строки задачи/запроса. */
export const MAX_QUERY_TOKENS = 24;
/** Минимальная длина терма, который стоит искать. */
export const MIN_TOKEN_LENGTH = 2;

const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

/** Термы свободного текста: нижний регистр, дедуп, фильтр по длине, cap. */
export function tokenizeQuery(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    const token = match[0] ?? "";
    if (token.length < MIN_TOKEN_LENGTH || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

/**
 * Собрать FTS5-запрос, безопасный для memory_fts MATCH ?: термы в кавычках,
 * соединение OR. p10a передаёт строку в MATCH verbatim, поэтому сырой текст
 * задачи (с операторами FTS) как запрос не используется.
 * @returns запрос или "" когда в тексте нет пригодного терма.
 */
export function buildFtsQuery(text: string): string {
  return tokenizeQuery(text)
    .map((token) => '"' + token.replace(/"/g, '""') + '"')
    .join(" OR ");
}
