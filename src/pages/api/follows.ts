/**
 * /api/follows — seguir/deixar de seguir (tudo autenticado via sessão).
 *
 * POST — segue { username }: resolve alvo público server-side, bloqueia
 *   self-follow, idempotente (já seguindo → following: true).
 *   200 { ok: true, following: true } · 404 "Perfil não disponível." ·
 *   400 input inválido.
 * DELETE — deixa de seguir { username }: idempotente (não seguia →
 *   removed: false). 200 { ok: true, following: false, removed }.
 * Estado de follow: GET /api/follows/state?username= (arquivo próprio).
 *
 * O browser nunca envia follower_id (servidor usa auth.uid()) e nunca
 * recebe UUID. Erros nunca vazam SQL, stack trace ou tokens.
 */
import type { APIRoute } from "astro";
import {
  FollowNotAvailableError,
  followUser,
  getFollowsSession,
  unfollowUser,
} from "../../lib/follows/service";
import {
  FollowValidationError,
  validateFollowTarget,
} from "../../lib/follows/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para seguir perfis.";
const FOLLOW_ERROR = "Não foi possível seguir este perfil.";
const UNFOLLOW_ERROR = "Não foi possível deixar de seguir.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getFollowsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateFollowTarget(body);
    await followUser(ctx, input);
    return Response.json({ ok: true, following: true });
  } catch (error) {
    if (error instanceof FollowValidationError) {
      return Response.json({ error: "Perfil inválido." }, { status: 400 });
    }
    if (error instanceof FollowNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Follows] Falha ao seguir.");
    return Response.json({ error: FOLLOW_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getFollowsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateFollowTarget(body);
    const removed = await unfollowUser(ctx, input);
    return Response.json({ ok: true, following: false, removed });
  } catch (error) {
    if (error instanceof FollowValidationError) {
      return Response.json({ error: "Perfil inválido." }, { status: 400 });
    }
    console.error("[Follows] Falha ao deixar de seguir.");
    return Response.json({ error: UNFOLLOW_ERROR }, { status: 500 });
  }
};
