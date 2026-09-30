/**
 * POST /api/notifications/read-all — marca toda a inbox como lida.
 *
 * Só rows do recipient (auth.uid() interno). Sem body.
 * Resposta: 200 { markedCount, unreadCount } · 401 deslogado.
 */
import type { APIRoute } from "astro";
import {
  getNotificationsSession,
  markAllMyNotificationsRead,
} from "../../../lib/notifications/service";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver suas notificações.";
const READ_ALL_ERROR = "Não foi possível marcar suas notificações agora.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getNotificationsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const result = await markAllMyNotificationsRead(ctx);
    return Response.json(result);
  } catch {
    console.error("[Notifications] Falha ao marcar todas lidas.");
    return Response.json({ error: READ_ALL_ERROR }, { status: 502 });
  }
};
