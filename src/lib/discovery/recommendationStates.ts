/**
 * Estados do usuário para recomendações exibidas (Etapa 10, server-side).
 *
 * Um request carrega, para até 8 títulos, o trio watchlist/watched/rating
 * em 3 queries pequenas (só tmdb_id/media_type/rating, com `.in()` +
 * filtro de media_type em código) — nunca N+1 por card. RLS vale em
 * cada query; nada além do trio sai daqui (sem email, user_id, profile).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import { getCurrentUser } from "../supabase/server";

export interface RecommendationItemKey {
  tmdbId: number;
  mediaType: ContentType;
}

export interface RecommendationUserState {
  inWatchlist: boolean;
  watched: boolean;
  rating: number | null;
}

/** Teto de itens por batch (4 cards + folga p/ replacements). */
export const MAX_STATE_ITEMS = 8;

function isValidKey(value: unknown): value is RecommendationItemKey {
  if (typeof value !== "object" || value === null) return false;
  const { tmdbId, mediaType } = value as Record<string, unknown>;
  return (
    typeof tmdbId === "number" &&
    Number.isSafeInteger(tmdbId) &&
    tmdbId > 0 &&
    (mediaType === "movie" || mediaType === "tv")
  );
}

/** Valida o body `{ items: [...] }`; `null` = inválido. */
export function parseStateItems(body: unknown): RecommendationItemKey[] | null {
  if (typeof body !== "object" || body === null) return null;
  const { items } = body as Record<string, unknown>;
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_STATE_ITEMS) {
    return null;
  }
  if (!items.every(isValidKey)) return null;
  const seen = new Set<string>();
  const out: RecommendationItemKey[] = [];
  for (const item of items as RecommendationItemKey[]) {
    const key = `${item.mediaType}:${item.tmdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ tmdbId: item.tmdbId, mediaType: item.mediaType });
  }
  return out;
}

export interface StatesContext {
  supabase: SupabaseClient;
  user: User;
}

/** Atalho: sessão atual ou `null` (chamador decide 401). */
export async function getStatesSession(
  request: Request,
  cookies: AstroCookies,
): Promise<StatesContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}

interface IdRow {
  tmdb_id: number;
  media_type: string;
}

interface RatingStateRow extends IdRow {
  rating: number;
}

/**
 * Carrega o trio para as chaves pedidas (3 queries paralelas, RLS).
 * Chave do mapa: `mediaType:tmdbId`.
 */
export async function getRecommendationUserStates(
  ctx: StatesContext,
  keys: RecommendationItemKey[],
): Promise<Record<string, RecommendationUserState>> {
  const ids = [...new Set(keys.map((k) => k.tmdbId))];
  const [watchlistRes, watchedRes, ratingsRes] = await Promise.all([
    ctx.supabase
      .from("watchlist")
      .select("tmdb_id,media_type")
      .eq("user_id", ctx.user.id)
      .in("tmdb_id", ids),
    ctx.supabase
      .from("watched_titles")
      .select("tmdb_id,media_type")
      .eq("user_id", ctx.user.id)
      .in("tmdb_id", ids),
    ctx.supabase
      .from("ratings")
      .select("tmdb_id,media_type,rating")
      .eq("user_id", ctx.user.id)
      .in("tmdb_id", ids),
  ]);
  if (watchlistRes.error || watchedRes.error || ratingsRes.error) {
    throw new Error("[RecStates] Falha ao carregar estados.");
  }

  const inSet = (rows: IdRow[] | null): Set<string> => {
    const set = new Set<string>();
    for (const row of rows ?? []) {
      if (row.media_type !== "movie" && row.media_type !== "tv") continue;
      set.add(`${row.media_type}:${Number(row.tmdb_id)}`);
    }
    return set;
  };
  const watchlist = inSet(watchlistRes.data as IdRow[] | null);
  const watched = inSet(watchedRes.data as IdRow[] | null);
  const ratings = new Map<string, number>();
  for (const row of (ratingsRes.data ?? []) as RatingStateRow[]) {
    if (row.media_type !== "movie" && row.media_type !== "tv") continue;
    ratings.set(`${row.media_type}:${Number(row.tmdb_id)}`, Number(row.rating));
  }

  const states: Record<string, RecommendationUserState> = {};
  for (const key of keys) {
    const mapKey = `${key.mediaType}:${key.tmdbId}`;
    states[mapKey] = {
      inWatchlist: watchlist.has(mapKey),
      watched: watched.has(mapKey),
      rating: ratings.get(mapKey) ?? null,
    };
  }
  return states;
}
