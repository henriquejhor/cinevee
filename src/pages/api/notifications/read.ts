/**
 * POST /api/notifications/read — marca ids como lidas (Etapa 21).
 *
 * Body: { notificationIds: number[] } (1..24, inteiros positivos,
 * dedupe; validação estrita → 400). IDs de outro usuário são
 * ignorados pela RPC (só recipient = auth.uid()).
 * Resposta: 200 { markedCount, unreadCount } · 401 deslogado.
 */
import type { APIRoute } from "astro";
import {
  getNotificationsSession,
  markMyNotificationsRead,
} from "../../../lib/notifications/service";
import { NotificationValidationError } from "../../../lib/notifications/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver suas notificações.";
const READ_ERROR = "Não foi possível marcar suas notificações agora.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getNotificationsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Selecione notificações válidas." }, { status: 400 });
  }

  try {
    const ids = (body as Record<string, unknown> | null)?.notificationIds;
    const result = await markMyNotificationsRead(ctx, ids);
    return Response.json(result);
  } catch (error) {
    if (error instanceof NotificationValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Notifications] Falha ao marcar lidas.");
    return Response.json({ error: READ_ERROR }, { status: 502 });
  }
};
