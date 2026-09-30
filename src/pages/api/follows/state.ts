/**
 * GET /api/follows/state?username= — estado de follow do usuário DA SESSÃO.
 *
 * 200 { following, isSelf }. Deslogado → 401. Alvo privado/inexistente →
 * { following: false, isSelf: false } (sem enumerar). Usado pelo botão
 * Seguir quando o SSR não sabe a sessão (ex.: validações extras).
 * O browser nunca envia follower_id e nunca recebe UUID.
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../../lib/http/cache";
import { getFollowsSession, getFollowState } from "../../../lib/follows/service";
import {
  FollowValidationError,
  validateFollowTarget,
} from "../../../lib/follows/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para seguir perfis.";
const STATE_ERROR = "Não foi possível verificar.";
const INVALID_PAGE = "Perfil inválido.";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const ctx = await getFollowsSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let input;
  try {
    input = validateFollowTarget({ username: url.searchParams.get("username") });
  } catch (error) {
    if (error instanceof FollowValidationError) {
      return Response.json({ error: INVALID_PAGE }, { status: 400 });
    }
    return Response.json({ error: STATE_ERROR }, { status: 500 });
  }

  try {
    const state = await getFollowState(ctx, input);
    // Resposta do dono: nunca em cache compartilhado.
    return privateJson(state);
  } catch {
    console.error("[Follows] Falha ao verificar estado.");
    return Response.json({ error: STATE_ERROR }, { status: 500 });
  }
};
