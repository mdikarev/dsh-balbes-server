/**
 * Время в ru-RU, с ISO как честным fallback. Пустая (или пробельная) строка —
 * отсутствие времени, и тогда показывается заглушка: пустая ячейка читалась бы
 * как сломанная вёрстка.
 */
export function formatCreatedAt(iso: string): string {
  if (iso.trim() === "") return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ru-RU");
}
