/**
 * Validação server-side do mark read (nunca confiar no browser).
 *
 * Regras: array 1..24, inteiros positivos seguros, dedupe preservando
 * a ordem (sem `in` sobre string, sem JSON frágil).
 */
import { NOTIFICATION_MARK_READ_MAX } from "./types";

export class NotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationValidationError";
  }
}

const INVALID_IDS = "Selecione notificações válidas.";

/** Valida notificationIds do POST /api/notifications/read. */
export function validateNotificationIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new NotificationValidationError(INVALID_IDS);
  }
  if (value.length > NOTIFICATION_MARK_READ_MAX) {
    throw new NotificationValidationError(
      `Selecione no máximo ${NOTIFICATION_MARK_READ_MAX} notificações.`,
    );
  }
  const clean: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 1) {
      throw new NotificationValidationError(INVALID_IDS);
    }
    if (!seen.has(item)) {
      seen.add(item);
      clean.push(item);
    }
  }
  return clean;
}

/** Valida page/limit de GETs paginados (1..24, default 24). */
export function validateNotificationPage(
  pageRaw: string | null,
  limitRaw: string | null,
  maxLimit: number,
): { page: number; limit: number } | null {
  const page = pageRaw === null ? 1 : Number(pageRaw);
  const limit = limitRaw === null ? maxLimit : Number(limitRaw);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) return null;
  return { page, limit };
}
