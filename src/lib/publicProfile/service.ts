/**
 * Leitura pública de perfis (Etapa 14) — SOMENTE via RPCs allowlisted.
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - NÃO exige autenticação: visitante anônimo visualiza (cookies, se
 *   existirem, não alteram permissões — a RPC é o único gate).
 * - NUNCA acessa as tabelas base diretamente: só `rpc("get_public_*")`.
 *   As policies privadas continuam bloqueando SELECT direto (inclusive
 *   para authenticated).
 * - Nenhum user_id/email/preferência/watchlist/TasteProfile passa por aqui:
 *   os tipos abaixo são o allowlist — o que não está aqui não vaza.
 * - Sem cache in-memory: desligar o perfil vale na próxima request.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import type { FollowState, PublicFollowCounts } from "../follows/types";
import { getRatingLikeStates } from "../ratingLikes/service";
import { getRatingCommentStates } from "../ratingComments/service";
import { createSupabaseServerClient } from "../supabase/server";
import { USERNAME_PATTERN } from "../profile/validation";
import { buildPosterUrl } from "../tmdb/image";

/** Teto por página pública (assistidos/avaliações). */
export const PUBLIC_PAGE_SIZE = 24;

const AVATAR_BUCKET = "avatars";

export interface PublicProfile {
  displayName: string | null;
  username: string;
  bio: string | null;
  avatarUrl: string | null;
  showFavorites: boolean;
  showRecommendations: boolean;
  showWatched: boolean;
  showRatings: boolean;
  showReviews: boolean;
}

export interface PublicPick {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  posterUrl?: string;
  year?: number;
  note?: string;
  position: number;
}

export interface PublicWatchedItem {
  tmdbId: number;
  mediaType: ContentType;
  title: string;
  posterUrl?: string;
  year?: number;
}

export interface PublicRatedTitle extends PublicWatchedItem {
  rating: number;
  /** NULL quando showReviews=false (mesmo existindo no banco). */
  reviewText: string | null;
  /**
   * Curtidas da rating (Etapa 18). Ausentes = RPC indisponível
   * (pré-migration) — UI degrada sem o controle.
   */
  likeCount?: number;
  likedByViewer?: boolean;
  /**
   * Comentários da rating (Etapa 19). Ausentes = RPC indisponível
   * (pré-migration) — UI degrada sem o controle.
   */
  commentCount?: number;
  commentsEnabled?: boolean;
}

export interface PublicPage<T> {
  items: T[];
  page: number;
  hasMore: boolean;
}

/** Resultado da busca de pessoas (Etapa 15): só identidade pública. */
export interface PublicPerson {
  displayName: string | null;
  username: string;
  bio: string | null;
  avatarUrl: string | null;
}

/** Limite padrão da busca de pessoas (RPC clamp 1..20). */
export const USER_SEARCH_LIMIT = 10;
/** Mínimo de caracteres para pesquisar pessoas (sem pesquisa ampla). */
export const USER_SEARCH_MIN_LENGTH = 2;

/**
 * Normaliza a query da busca de pessoas: trim + lowercase + remove UM @
 * inicial. Não remove caracteres internos. Retorna "" se vazia.
 */
export function normalizeUserSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("@")) return trimmed.slice(1);
  return trimmed;
}

/** Query curta demais → sem chamada (a UI mostra orientação, sem erro). */
export function isUserSearchQueryValid(query: string): boolean {
  return query.length >= USER_SEARCH_MIN_LENGTH;
}

interface PublicPersonRow {
  display_name: string | null;
  username: string;
  bio: string | null;
  avatar_path: string | null;
}

/**
 * Busca pessoas (perfis públicos + discoverable) via RPC allowlisted.
 * Sem autenticação. Retorna [] para query curta ou falha de banco
 * (nunca erro SQL vazado, nunca PII além da identidade pública).
 */
export async function searchPublicProfiles(
  supabase: SupabaseClient,
  query: string,
): Promise<PublicPerson[]> {
  if (!isUserSearchQueryValid(query)) return [];

  const { data, error } = await supabase.rpc("search_public_profiles", {
    p_query: query,
    p_limit: USER_SEARCH_LIMIT,
  });

  if (error || !Array.isArray(data)) return [];

  const people: PublicPerson[] = [];
  for (const row of data as PublicPersonRow[]) {
    if (!row || typeof row.username !== "string" || row.username.length === 0) {
      continue;
    }
    people.push({
      displayName: row.display_name,
      username: row.username,
      bio: row.bio,
      avatarUrl: avatarPublicUrl(supabase, row.avatar_path),
    });
  }
  return people;
}

/** Slug /u/[username]: lowercase, mesma regra de usernames (sem criar outra). */
export function normalizePublicUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) return null;
  return normalized;
}

/** Client server-side sem exigir login (anônimo também lê via RPC). */
export function getPublicSupabase(
  request: Request,
  cookies: AstroCookies,
): SupabaseClient {
  return createSupabaseServerClient(request, cookies);
}

function avatarPublicUrl(
  supabase: SupabaseClient,
  avatarPath: string | null,
): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

interface PublicProfileRow {
  display_name: string | null;
  username: string;
  bio: string | null;
  avatar_path: string | null;
  show_favorites: boolean;
  show_recommendations: boolean;
  show_watched: boolean;
  show_ratings: boolean;
  show_reviews: boolean;
}

/**
 * Identidade pública ou `null` (inexistente OU privado — equivalentes).
 * Falha de banco vira `null` (página 404), nunca erro SQL vazado.
 */
export async function getPublicProfile(
  supabase: SupabaseClient,
  username: string,
): Promise<PublicProfile | null> {
  const { data, error } = await supabase.rpc("get_public_profile", {
    p_username: username,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  const row = data[0] as PublicProfileRow;
  if (!row || typeof row.username !== "string") return null;

  return {
    displayName: row.display_name,
    username: row.username,
    bio: row.bio,
    avatarUrl: avatarPublicUrl(supabase, row.avatar_path),
    showFavorites: row.show_favorites === true,
    showRecommendations: row.show_recommendations === true,
    showWatched: row.show_watched === true,
    showRatings: row.show_ratings === true,
    showReviews: row.show_reviews === true && row.show_ratings === true,
  };
}

interface PublicPickRow {
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
  note?: string | null;
  position: number;
}

function toPublicPick(row: PublicPickRow): PublicPick {
  const posterUrl = buildPosterUrl(row.poster_path ?? null);
  return {
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    title: row.title,
    ...(posterUrl ? { posterUrl } : {}),
    ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    position: Number(row.position),
  };
}

/** Favoritos públicos (position ASC). Vazio quando flag desligada. */
export async function getPublicFavorites(
  supabase: SupabaseClient,
  username: string,
): Promise<PublicPick[]> {
  const { data, error } = await supabase.rpc("get_public_favorites", {
    p_username: username,
  });

  if (error || !Array.isArray(data)) return [];
  return (data as PublicPickRow[]).map(toPublicPick);
}

/** Recomendações públicas (position ASC, com nota em texto puro). */
export async function getPublicRecommendations(
  supabase: SupabaseClient,
  username: string,
): Promise<PublicPick[]> {
  const { data, error } = await supabase.rpc("get_public_recommendations", {
    p_username: username,
  });

  if (error || !Array.isArray(data)) return [];
  return (data as PublicPickRow[]).map(toPublicPick);
}

/** Página validada: inteiro ≥1 (inválido → null, chamador decide 400/404). */
export function parsePublicPage(value: unknown): number | null {
  const page = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return null;
  return page;
}

interface PublicWatchedRow {
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
}

function toPublicWatchedItem(row: PublicWatchedRow): PublicWatchedItem {
  const posterUrl = buildPosterUrl(row.poster_path ?? null);
  return {
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    title: row.title,
    ...(posterUrl ? { posterUrl } : {}),
    ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
  };
}

/**
 * Página pública + hasMore sem violar o teto da RPC.
 *
 * A RPC nunca retorna mais de 24 rows (clamp no SQL), então pedir
 * limit+1 para detectar a próxima página não funciona (sempre caberia
 * em 24). Em vez disso: página cheia (24) + sonda leve (1 row no offset
 * seguinte), em paralelo, ambas pela MESMA RPC (mesmas flags/RLS).
 * Sonda com falha → hasMore false (falha fechada: só oculta o botão,
 * nunca expõe dado extra). Vale para watched e ratings (helper único).
 */
async function fetchPublicPage<T>(
  rpc: string,
  username: string,
  page: number,
  supabase: SupabaseClient,
  map: (row: never) => T,
): Promise<PublicPage<T>> {
  const offset = (page - 1) * PUBLIC_PAGE_SIZE;
  const [main, probe] = await Promise.all([
    supabase.rpc(rpc, {
      p_username: username,
      p_limit: PUBLIC_PAGE_SIZE,
      p_offset: offset,
    }),
    supabase.rpc(rpc, {
      p_username: username,
      p_limit: 1,
      p_offset: offset + PUBLIC_PAGE_SIZE,
    }),
  ]);

  if (main.error || !Array.isArray(main.data)) {
    throw new Error("[PublicProfile] Falha ao carregar lista pública.");
  }

  const rows = main.data as never[];
  const hasMore = Array.isArray(probe.data) && probe.data.length > 0;
  return {
    items: rows.slice(0, PUBLIC_PAGE_SIZE).map(map),
    page,
    hasMore,
  };
}

/** Assistidos públicos (watched_at DESC, sem expor a data). */
export async function getPublicWatched(
  supabase: SupabaseClient,
  username: string,
  page: number,
): Promise<PublicPage<PublicWatchedItem>> {
  return fetchPublicPage(
    "get_public_watched",
    username,
    page,
    supabase,
    toPublicWatchedItem as (row: never) => PublicWatchedItem,
  );
}

interface PublicRatingRow extends PublicWatchedRow {
  rating: number;
  review_text: string | null;
}

/** Avaliações públicas (reviews só quando o dono ligou showReviews). */
export async function getPublicRatings(
  supabase: SupabaseClient,
  username: string,
  page: number,
): Promise<PublicPage<PublicRatedTitle>> {
  const result = await fetchPublicPage(
    "get_public_ratings",
    username,
    page,
    supabase,
    ((row: PublicRatingRow): PublicRatedTitle => ({
      ...toPublicWatchedItem(row),
      rating: Number(row.rating),
      reviewText: typeof row.review_text === "string" ? row.review_text : null,
    })) as (row: never) => PublicRatedTitle,
  );

  // Curtidas + comentários da página em chamadas batch (Etapa 18/19,
  // em paralelo, sem N+1). Anon → likedByViewer false. Falha/ausência
  // das RPCs → sem os campos (degrada sem quebrar).
  const targets = result.items.map((item) => ({
    username,
    tmdbId: item.tmdbId,
    mediaType: item.mediaType,
  }));
  const [likeStates, commentStates] = await Promise.all([
    getRatingLikeStates(supabase, targets).catch(() => []),
    getRatingCommentStates(supabase, targets).catch(() => []),
  ]);
    const likesByKey = new Map(
      likeStates.map((s) => [`${s.mediaType}:${s.tmdbId}`, s]),
    );
    const commentsByKey = new Map(
      commentStates.map((s) => [`${s.mediaType}:${s.tmdbId}`, s]),
    );
    for (const item of result.items) {
      const key = `${item.mediaType}:${item.tmdbId}`;
      const likeState = likesByKey.get(key);
      if (likeState) {
        item.likeCount = likeState.likeCount;
        item.likedByViewer = likeState.likedByViewer;
      }
      const commentState = commentsByKey.get(key);
      if (commentState) {
        item.commentCount = commentState.commentCount;
        item.commentsEnabled = commentState.commentsEnabled;
      }
    }
  return result;
}

/**
 * Contadores públicos de follow (Etapa 16).
 * followers = total de relações; following = só alvos públicos.
 * Privado/inexistente → zeros (página 404 de qualquer forma).
 */
export async function getPublicFollowCounts(
  supabase: SupabaseClient,
  username: string,
): Promise<PublicFollowCounts> {
  const { data, error } = await supabase.rpc("get_public_follow_counts", {
    p_username: username,
  });

  if (error || !Array.isArray(data) || data.length === 0) {
    return { followersCount: 0, followingCount: 0 };
  }

  const row = data[0] as {
    followers_count?: unknown;
    following_count?: unknown;
  };
  const toCount = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : Number(value) || 0;
  return {
    followersCount: toCount(row.followers_count),
    followingCount: toCount(row.following_count),
  };
}

function toPublicPerson(
  supabase: SupabaseClient,
  row: PublicPersonRow,
): PublicPerson | null {
  if (!row || typeof row.username !== "string" || row.username.length === 0) {
    return null;
  }
  return {
    displayName: row.display_name,
    username: row.username,
    bio: row.bio,
    avatarUrl: avatarPublicUrl(supabase, row.avatar_path),
  };
}

function toPublicPersonPage(
  supabase: SupabaseClient,
): (row: never) => PublicPerson {
  return ((row: PublicPersonRow): PublicPerson =>
    toPublicPerson(supabase, row) as PublicPerson) as (row: never) => PublicPerson;
}

/**
 * Seguidores públicos (só perfis públicos, recentes primeiro).
 * Falha/privado → exceção (página decide 404/500 como nas outras listas).
 */
export async function getPublicFollowers(
  supabase: SupabaseClient,
  username: string,
  page: number,
): Promise<PublicPage<PublicPerson>> {
  const result = await fetchPublicPage(
    "get_public_followers",
    username,
    page,
    supabase,
    toPublicPersonPage(supabase),
  );
  return {
    ...result,
    items: result.items.filter((item) => item !== null),
  };
}

/** Seguindo públicos (só alvos públicos, recentes primeiro). */
export async function getPublicFollowing(
  supabase: SupabaseClient,
  username: string,
  page: number,
): Promise<PublicPage<PublicPerson>> {
  const result = await fetchPublicPage(
    "get_public_following",
    username,
    page,
    supabase,
    toPublicPersonPage(supabase),
  );
  return {
    ...result,
    items: result.items.filter((item) => item !== null),
  };
}

/**
 * Estado de follow do visitante em relação ao perfil (Etapa 16).
 * Usa o client da request (com cookies quando logado): anon, privado,
 * inexistente ou self → { following: false, isSelf: false }.
 * Nunca expõe UUID — só os dois booleanos.
 */
export async function getPublicFollowState(
  supabase: SupabaseClient,
  username: string,
): Promise<FollowState> {
  const { data, error } = await supabase.rpc("get_follow_state", {
    p_username: username,
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
