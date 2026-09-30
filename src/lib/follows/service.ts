/**
 * Camada server-side de follows (Etapa 16).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - Mutações passam pelas RPCs follow/unfollow_by_username, que resolvem
 *   o alvo por username + exigem alvo público + bloqueiam self-follow.
 *   O browser NUNCA envia follower_id (servidor usa auth.uid()).
 * - Erro genérico "Perfil não disponível." para privado/inexistente/self
 *   no follow (sem enumerar); unfollow é idempotente (false = nada feito).
 * - Leitura de estado/counts próprios via sessão; listas/counts de
 *   terceiros SOMENTE via RPCs públicas allowlisted (nunca tabela direta).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import type {
  FollowState,
  FollowTargetInput,
  MyFollowCounts,
} from "./types";

/** Alvo privado/inexistente (ou self no follow) → 404 genérico. */
export class FollowNotAvailableError extends Error {
  constructor() {
    super("Perfil não disponível.");
    this.name = "FollowNotAvailableError";
  }
}

export interface FollowsContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Segue o perfil (idempotente: já seguindo → true, sem erro).
 * Alvo privado/inexistente/self → FollowNotAvailableError.
 */
export async function followUser(
  ctx: FollowsContext,
  input: FollowTargetInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase.rpc("follow_user_by_username", {
    p_username: input.username,
  });

  if (error) {
    // Log server-side com detalhe real (nunca exposto ao browser);
    // o client recebe SEMPRE o erro genérico (sem enumerar).
    console.error("[Follows] follow_user_by_username falhou:", error);
    throw new FollowNotAvailableError();
  }

  return data === true;
}

/**
 * Deixa de seguir (idempotente: não seguia → false, sem erro).
 * Retorna `true` se uma relação foi removida.
 */
export async function unfollowUser(
  ctx: FollowsContext,
  input: FollowTargetInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase.rpc("unfollow_user_by_username", {
    p_username: input.username,
  });

  if (error) {
    console.error("[Follows] unfollow_user_by_username falhou:", error);
    throw new Error("[Follows] Falha ao deixar de seguir.");
  }

  return data === true;
}

/**
 * Estado de follow do usuário DA SESSÃO em relação ao perfil.
 * Privado/inexistente → { following: false, isSelf: false } (sem enumerar).
 */
export async function getFollowState(
  ctx: FollowsContext,
  input: FollowTargetInput,
): Promise<FollowState> {
  const { data, error } = await ctx.supabase.rpc("get_follow_state", {
    p_username: input.username,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { following: false, isSelf: false };
  }

  const row = data[0] as { following?: unknown; is_self?: unknown };
  return {
    following: row.following === true,
    isSelf: row.is_self === true,
  };
}

/**
 * Contadores próprios (totais). Pré-migration da Etapa 16: zeros
 * (página degrada sem quebrar — mesmo padrão das outras seções).
 */
export async function getMyFollowCounts(
  ctx: FollowsContext,
): Promise<MyFollowCounts> {
  const { data, error } = await ctx.supabase.rpc("get_my_follow_counts");

  if (error || !Array.isArray(data) || data.length === 0) {
    return { followersTotal: 0, followingTotal: 0, followingPublic: 0 };
  }

  const row = data[0] as {
    followers_total?: unknown;
    following_total?: unknown;
    following_public?: unknown;
  };
  const toCount = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : Number(value) || 0;
  return {
    followersTotal: toCount(row.followers_total),
    followingTotal: toCount(row.following_total),
    followingPublic: toCount(row.following_public),
  };
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getFollowsSession(
  request: Request,
  cookies: AstroCookies,
): Promise<FollowsContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
