/**
 * Camada server-side de curtidas em avaliações (Etapa 18).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - Mutações passam pelas RPCs like/unlike_rating_by_username, que usam
 *   auth.uid() interno. O browser NUNCA envia liker_id/owner_id.
 * - Erro genérico "Avaliação indisponível." para privado/inexistente/sem
 *   rating (sem enumerar); self-like tem erro próprio (→ 409).
 * - States em lote via get_public_rating_like_states (1 RPC p/ até 24
 *   targets — sem N+1). Erro real vai para o log server-side (nunca para
 *   o browser); o client recebe mensagens simples (aprendizado Etapa 16).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import type {
  RatingLikeResult,
  RatingLikeState,
  RatingLikeTarget,
} from "./types";
import { RATING_LIKE_BATCH_SIZE } from "./types";

/** Alvo privado/inexistente/sem rating → 404 genérico. */
export class RatingLikeNotAvailableError extends Error {
  constructor() {
    super("Avaliação indisponível.");
    this.name = "RatingLikeNotAvailableError";
  }
}

/** Self-like → 409 (documentado; DB tem CHECK como última camada). */
export class SelfLikeError extends Error {
  constructor() {
    super("Você não pode curtir sua própria avaliação.");
    this.name = "SelfLikeError";
  }
}

export interface RatingLikesContext {
  supabase: SupabaseClient;
  user: User;
}

const SELF_MESSAGE = "Você não pode curtir sua própria avaliação.";

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Curte a avaliação (idempotente: já curtida → liked true, sem erro).
 * Alvo indisponível → RatingLikeNotAvailableError; própria → SelfLikeError.
 */
export async function likeRating(
  ctx: RatingLikesContext,
  target: RatingLikeTarget,
): Promise<RatingLikeResult> {
  const { data, error } = await ctx.supabase.rpc("like_rating_by_username", {
    p_username: target.username,
    p_tmdb_id: target.tmdbId,
    p_media_type: target.mediaType,
  });

  if (error) {
    console.error("[RatingLikes] like_rating_by_username falhou:", error);
    if (error.message === SELF_MESSAGE) {
      throw new SelfLikeError();
    }
    throw new RatingLikeNotAvailableError();
  }

  const row = (Array.isArray(data) ? data[0] : null) as {
    liked?: unknown;
    like_count?: unknown;
  } | null;
  return { liked: true, likeCount: toCount(row?.like_count) };
}

/**
 * Descurte a avaliação (idempotente: não curtida → liked false, sem erro).
 * Funciona mesmo com alvo escondido (resolve o dono atual pelo username).
 */
export async function unlikeRating(
  ctx: RatingLikesContext,
  target: RatingLikeTarget,
): Promise<RatingLikeResult> {
  const { data, error } = await ctx.supabase.rpc("unlike_rating_by_username", {
    p_username: target.username,
    p_tmdb_id: target.tmdbId,
    p_media_type: target.mediaType,
  });

  if (error) {
    console.error("[RatingLikes] unlike_rating_by_username falhou:", error);
    throw new Error("[RatingLikes] Falha ao remover curtida.");
  }

  const row = (Array.isArray(data) ? data[0] : null) as {
    removed?: unknown;
    like_count?: unknown;
  } | null;
  return { liked: false, likeCount: toCount(row?.like_count) };
}

/**
 * States públicos em lote (até 24 targets). Só ratings visíveis retornam;
 * ausente = escondida/inexistente (sem oracle). Anon → likedByViewer false.
 * Falha/ausência da RPC (pré-migration) → [] (degrada sem quebrar).
 */
export async function getRatingLikeStates(
  supabase: SupabaseClient,
  targets: RatingLikeTarget[],
): Promise<RatingLikeState[]> {
  const limited = targets.slice(0, RATING_LIKE_BATCH_SIZE);
  if (limited.length === 0) return [];

  const { data, error } = await supabase.rpc("get_public_rating_like_states", {
    p_targets: limited.map((t) => ({
      username: t.username,
      tmdb_id: t.tmdbId,
      media_type: t.mediaType,
    })),
  });

  if (error || !Array.isArray(data)) {
    return [];
  }

  const states: RatingLikeState[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (!row || typeof row !== "object") continue;
    const { username, tmdb_id, media_type, like_count, liked_by_viewer } = row;
    if (typeof username !== "string" || username.length === 0) continue;
    const tmdbId = Number(tmdb_id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) continue;
    if (media_type !== "movie" && media_type !== "tv") continue;
    states.push({
      username,
      tmdbId,
      mediaType: media_type,
      likeCount: toCount(like_count),
      likedByViewer: liked_by_viewer === true,
    });
  }
  return states;
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getRatingLikesSession(
  request: Request,
  cookies: AstroCookies,
): Promise<RatingLikesContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
