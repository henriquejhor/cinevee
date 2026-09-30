/**
 * GET /api/notifications/unread-count — sino (Etapa 21).
 *
 * Autenticado: 200 { unreadCount }. Deslogado: 401 (o sino usa isso
 * para descobrir se existe sessão — anon nunca vê sino).
 * Sem polling: o client chama no carregamento/navegação e após mark.
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../../lib/http/cache";
import {
  getMyUnreadNotificationCount,
  getNotificationsSession,
} from "../../../lib/notifications/service";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver suas notificações.";
const COUNT_ERROR = "Não foi possível contar suas notificações agora.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const ctx = await getNotificationsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const unreadCount = await getMyUnreadNotificationCount(ctx);
    return privateJson({ unreadCount });
  } catch {
    console.error("[Notifications] Falha ao contar não lidas.");
    return Response.json({ error: COUNT_ERROR }, { status: 502 });
  }
};
