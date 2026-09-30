/**
 * GET /api/notifications — inbox privada (Etapa 21).
 *
 * Autenticado (recipient = auth.uid() interno). Params: `page`
 * (1..1000, default 1), `limit` (1..24, default 24).
 * Resposta: 200 { items, page, pageSize, hasMore } · 401 deslogado ·
 * 400 página inválida · 502 sem vazar SQL.
 * GET nunca marca como lida (mark é POST explícito client-side).
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../lib/http/cache";
import {
  getMyNotificationsPage,
  getNotificationsSession,
} from "../../lib/notifications/service";
import {
  NOTIFICATION_PAGE_SIZE,
  type NotificationPage,
} from "../../lib/notifications/types";
import { validateNotificationPage } from "../../lib/notifications/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para ver suas notificações.";
const LIST_ERROR = "Não foi possível carregar suas notificações agora.";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const ctx = await getNotificationsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  const parsed = validateNotificationPage(
    url.searchParams.get("page") ?? "1",
    url.searchParams.get("limit"),
    NOTIFICATION_PAGE_SIZE,
  );
  if (!parsed) {
    return Response.json({ error: "Página inválida." }, { status: 400 });
  }

  try {
    const result: NotificationPage = await getMyNotificationsPage(ctx, parsed.page, parsed.limit);
    return privateJson(result);
  } catch {
    console.error("[Notifications] Falha ao carregar inbox.");
    return Response.json({ error: LIST_ERROR }, { status: 502 });
  }
};
