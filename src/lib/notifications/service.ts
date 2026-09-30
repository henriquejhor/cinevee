/**
 * Camada server-side de notificações in-app (Etapa 21).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O recipient é sempre auth.uid() interno das RPCs. O browser NUNCA
 *   envia user_id/recipient_id — nem para ler, nem para marcar lida.
 * - Sem `.from("notifications")` em lugar nenhum: leitura e escrita
 *   passam pelas RPCs controladas (RLS sem policies bloqueia o direto).
 * - Inbox privada: sem gates de profile_public/show_ratings na leitura
 *   (cascade remove quando a fonte some). Actor resolvido pelo profile
 *   atual (dinâmico). Title via snapshot watched (sem TMDB).
 * - Erro real vai para o log server-side (nunca para o browser); o
 *   client recebe mensagens simples (aprendizado Etapas 16/19).
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import { buildPosterUrl } from "../tmdb/image";
import type { AstroCookies } from "astro";
import {
  isNotificationType,
  NOTIFICATION_PAGE_SIZE,
  type NotificationItem,
  type NotificationPage,
  type NotificationReadResult,
} from "./types";
import { validateNotificationIds, validateNotificationPage } from "./validation";

export interface NotificationsContext {
  supabase: SupabaseClient;
  user: User;
}

const AVATAR_BUCKET = "avatars";

function avatarPublicUrl(supabase: SupabaseClient, avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function toNotificationItem(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): NotificationItem | null {
  const notificationId = row.notification_id;
  const type = row.type;
  if (typeof notificationId !== "number" || !Number.isSafeInteger(notificationId) || notificationId < 1) {
    return null;
  }
  if (!isNotificationType(type)) return null;

  const actorIsPrivate = row.actor_is_private === true;
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  if (!createdAt) return null;
  const readAt = typeof row.read_at === "string" ? row.read_at : null;

  let title: NotificationItem["title"] = null;
  if (type === "rating_like" || type === "rating_comment" || type === "comment_reply") {
    const tmdbId = row.tmdb_id;
    const mediaType = row.media_type;
    if (typeof tmdbId !== "number" || !Number.isSafeInteger(tmdbId) || tmdbId < 1) return null;
    if (mediaType !== "movie" && mediaType !== "tv") return null;
    // Normalização única (Etapa 22): RPC devolve poster_path cru —
    // monta a URL TMDB aqui (puro string, sem request). Nunca repassar
    // o path como src (pôster quebrado).
    const posterUrl = buildPosterUrl(
      typeof row.poster_path === "string" ? row.poster_path : null,
    );
    title = {
      tmdbId,
      mediaType,
      title: typeof row.title === "string" ? row.title : null,
      posterUrl: posterUrl ?? null,
      year: typeof row.release_year === "number" && Number.isSafeInteger(row.release_year) ? row.release_year : null,
    };
  }

  return {
    notificationId,
    type,
    actor: {
      isPrivate: actorIsPrivate,
      displayName: !actorIsPrivate && typeof row.actor_display_name === "string" ? row.actor_display_name : null,
      username: !actorIsPrivate && typeof row.actor_username === "string" ? row.actor_username : null,
      avatarUrl: !actorIsPrivate ? avatarPublicUrl(supabase, typeof row.actor_avatar_path === "string" ? row.actor_avatar_path : null) : null,
    },
    title,
    commentText: type === "rating_comment" && typeof row.comment_text === "string" ? row.comment_text : null,
    replyText: type === "comment_reply" && typeof row.reply_text === "string" ? row.reply_text : null,
    createdAt,
    readAt,
    isRead: readAt !== null,
  };
}

/** Sessão da API (401 quando deslogado). */
export async function getNotificationsSession(
  request: Request,
  cookies: AstroCookies,
): Promise<NotificationsContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}

/**
 * Página da inbox (24 + probe no próximo offset — sem limit+1 contra
 * o clamp da RPC). Dedupe por notificationId (defesa em profundidade).
 */
export async function getMyNotificationsPage(
  ctx: NotificationsContext,
  page: number,
  limit: number = NOTIFICATION_PAGE_SIZE,
): Promise<NotificationPage> {
  const offset = (page - 1) * limit;
  const { data, error } = await ctx.supabase.rpc("get_my_notifications", {
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    throw new Error("[Notifications] Falha ao carregar notificações.");
  }
  const rows = Array.isArray(data) ? data : [];
  const items: NotificationItem[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = toNotificationItem(ctx.supabase, row as Record<string, unknown>);
    if (!item || seen.has(item.notificationId)) continue;
    seen.add(item.notificationId);
    items.push(item);
  }

  let hasMore = false;
  const probe = await ctx.supabase.rpc("get_my_notifications", {
    p_limit: 1,
    p_offset: offset + limit,
  });
  if (!probe.error && Array.isArray(probe.data)) {
    hasMore = probe.data.length > 0;
  }

  return { items, page, pageSize: limit, hasMore };
}

/** Contador de não lidas (sino). */
export async function getMyUnreadNotificationCount(ctx: NotificationsContext): Promise<number> {
  const { data, error } = await ctx.supabase.rpc("get_my_notification_unread_count");
  if (error) {
    throw new Error("[Notifications] Falha ao contar notificações.");
  }
  const row = (Array.isArray(data) ? data[0] : null) as { unread_count?: unknown } | null;
  return toCount(row?.unread_count);
}

/** Marca ids como lidas (só do dono — a RPC filtra; validação 1..24 aqui). */
export async function markMyNotificationsRead(
  ctx: NotificationsContext,
  ids: unknown,
): Promise<NotificationReadResult> {
  const clean = validateNotificationIds(ids);
  const { data, error } = await ctx.supabase.rpc("mark_my_notifications_read", {
    p_notification_ids: clean,
  });
  if (error) {
    throw new Error("[Notifications] Falha ao marcar notificações.");
  }
  const row = (Array.isArray(data) ? data[0] : null) as {
    marked_count?: unknown;
    unread_count?: unknown;
  } | null;
  return { markedCount: toCount(row?.marked_count), unreadCount: toCount(row?.unread_count) };
}

/** Marca toda a inbox como lida. */
export async function markAllMyNotificationsRead(
  ctx: NotificationsContext,
): Promise<NotificationReadResult> {
  const { data, error } = await ctx.supabase.rpc("mark_all_my_notifications_read");
  if (error) {
    throw new Error("[Notifications] Falha ao marcar notificações.");
  }
  const row = (Array.isArray(data) ? data[0] : null) as {
    marked_count?: unknown;
    unread_count?: unknown;
  } | null;
  return { markedCount: toCount(row?.marked_count), unreadCount: toCount(row?.unread_count) };
}

export { validateNotificationPage };
