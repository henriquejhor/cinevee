/**
 * Tipos das notificações in-app (Etapa 21).
 *
 * Desacoplados da linha raw do banco: o restante do app consome
 * `NotificationItem`, nunca recipient_id/actor_id/UUID. O que não está
 * aqui não vaza (sem email, sem flags de privacidade, sem chaves).
 * Notificação NÃO é evento de feed e NÃO entra em TasteProfile.
 */
import type { ContentType } from "../../types/content";

/** Ações que geram notification. Chaves semânticas, nunca labels. */
export type NotificationType = "follow" | "rating_like" | "rating_comment" | "comment_reply";

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  "follow",
  "rating_like",
  "rating_comment",
  "comment_reply",
];

export function isNotificationType(value: unknown): value is NotificationType {
  return (
    value === "follow" ||
    value === "rating_like" ||
    value === "rating_comment" ||
    value === "comment_reply"
  );
}

/** Tamanho da página (mesmo padrão estabilizado: 24 + probe). */
export const NOTIFICATION_PAGE_SIZE = 24;

/** Máximo de ids por request de mark read. */
export const NOTIFICATION_MARK_READ_MAX = 24;

export interface NotificationActor {
  /** Actor privado → identidade oculta (só isPrivate + genéricos). */
  isPrivate: boolean;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
}

export interface NotificationTitle {
  tmdbId: number;
  mediaType: ContentType;
  /** Snapshot do watched do recipient (sem TMDB). Pode faltar. */
  title: string | null;
  posterUrl: string | null;
  year: number | null;
}

export interface NotificationItem {
  notificationId: number;
  type: NotificationType;
  actor: NotificationActor;
  /** Só rating_like/rating_comment/comment_reply (follow não tem título). */
  title: NotificationTitle | null;
  /** Só rating_comment (texto ATUAL — edit reflete sem nova row). */
  commentText: string | null;
  /** Só comment_reply (texto ATUAL — edit reflete sem nova row). */
  replyText: string | null;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
}

export interface NotificationPage {
  items: NotificationItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface NotificationReadResult {
  markedCount: number;
  unreadCount: number;
}
