/**
 * Camada server-side do feed "Seguindo" (Etapa 17).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O viewer sempre vem da sessão autenticada (`auth.getUser()`); a RPC
 *   resolve o follower via auth.uid() interno — o browser NUNCA envia
 *   identificação do viewer (não há parâmetro para isso).
 * - Leitura em UMA RPC por página (principal + sonda hasMore, em paralelo).
 *   Sem N+1: atores e snapshots vêm na mesma chamada.
 * - Pré-migration da Etapa 17: páginas vazias (UI degrada sem quebrar —
 *   mesmo padrão das outras seções).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import { buildPosterUrl } from "../tmdb/image";
import type { ContentType } from "../../types/content";
import { getRatingLikeStates } from "../ratingLikes/service";
import { getRatingCommentStates } from "../ratingComments/service";
import {
  FEED_EVENT_TYPES,
  FEED_PAGE_SIZE,
  type FeedEvent,
  type FeedEventType,
  type FeedPage,
} from "./types";

const AVATAR_BUCKET = "avatars";

export interface FeedContext {
  supabase: SupabaseClient;
  user: User;
}

interface FeedRow {
  event_type: string;
  actor_display_name: string | null;
  actor_username: string;
  actor_avatar_path: string | null;
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
  rating: number | null;
  review_text: string | null;
  note: string | null;
  activity_at: string;
}

function avatarPublicUrl(
  supabase: SupabaseClient,
  avatarPath: string | null,
): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

function isFeedEventType(value: string): value is FeedEventType {
  return (FEED_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Chave opaca de dedupe (só campos públicos — sem UUID).
 * Única por constraints UNIQUE das origens (rating e pick são únicos
 * por usuário+título+kind), então overlap de páginas nunca duplica cards.
 */
export function feedEventKey(
  type: FeedEventType,
  username: string,
  mediaType: string,
  tmdbId: number,
): string {
  return `${type}:${username}:${mediaType}:${tmdbId}`;
}

function toFeedEvent(supabase: SupabaseClient, row: FeedRow): FeedEvent | null {
  if (!isFeedEventType(row.event_type)) return null;
  if (typeof row.actor_username !== "string" || row.actor_username.length === 0) {
    return null;
  }
  const tmdbId = Number(row.tmdb_id);
  if (!Number.isSafeInteger(tmdbId)) return null;
  if (row.media_type !== "movie" && row.media_type !== "tv") return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  if (typeof row.activity_at !== "string" || Number.isNaN(Date.parse(row.activity_at))) {
    return null;
  }

  const type = row.event_type;
  const posterUrl = buildPosterUrl(row.poster_path ?? null);
  const event: FeedEvent = {
    eventKey: feedEventKey(type, row.actor_username, row.media_type, tmdbId),
    type,
    actor: {
      displayName:
        typeof row.actor_display_name === "string" ? row.actor_display_name : null,
      username: row.actor_username,
      avatarUrl: avatarPublicUrl(supabase, row.actor_avatar_path ?? null),
    },
    title: {
      tmdbId,
      mediaType: row.media_type as ContentType,
      title: row.title,
      ...(posterUrl ? { posterUrl } : {}),
      ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
    },
    text: null,
    activityAt: row.activity_at,
  };

  if (type === "rating") {
    const rating = Number(row.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;
    event.rating = rating;
    event.text = typeof row.review_text === "string" ? row.review_text : null;
  } else if (type === "recommendation") {
    event.text = typeof row.note === "string" ? row.note : null;
  }
  return event;
}

/**
 * Uma página do feed do viewer (principal + sonda hasMore, em paralelo).
 * Mesma técnica das listas públicas: a RPC tem clamp 1..24 no SQL, então
 * limit+1 não detectaria a próxima página — a sonda (1 row no offset
 * seguinte, mesma RPC) resolve. Sonda com falha → hasMore false
 * (falha fechada: só oculta o botão, nunca expõe dado extra).
 * Pré-migration: { items: [], hasMore: false } (degrada sem quebrar).
 */
export async function getFollowingFeedPage(
  ctx: FeedContext,
  page: number,
  pageSize: number = FEED_PAGE_SIZE,
): Promise<FeedPage> {
  const size =
    Number.isSafeInteger(pageSize) && pageSize >= 1
      ? Math.min(pageSize, FEED_PAGE_SIZE)
      : FEED_PAGE_SIZE;
  const offset = (page - 1) * size;
  const [main, probe] = await Promise.all([
    ctx.supabase.rpc("get_following_feed", { p_limit: size, p_offset: offset }),
    ctx.supabase.rpc("get_following_feed", {
      p_limit: 1,
      p_offset: offset + size,
    }),
  ]);

  if (main.error || !Array.isArray(main.data)) {
    return { items: [], page, hasMore: false };
  }

  const items: FeedEvent[] = [];
  for (const row of main.data as FeedRow[]) {
    if (!row || typeof row !== "object") continue;
    const event = toFeedEvent(ctx.supabase, row);
    if (event) items.push(event);
  }

  // Curtidas + comentários das ratings da página em chamadas batch
  // (sem N+1, em paralelo). Favorite/recommendation nunca recebem
  // like/comment. Falha/ausência das RPCs (pré-Etapas 18/19) → eventos
  // sem os campos (degrada sem quebrar). Não altera rated_at/ordem:
  // like e comment nunca são eventos do feed.
  const ratingTargets = items
    .filter((event) => event.type === "rating")
    .map((event) => ({
      username: event.actor.username,
      tmdbId: event.title.tmdbId,
      mediaType: event.title.mediaType,
    }));
  if (ratingTargets.length > 0) {
    const [likeStates, commentStates] = await Promise.all([
      getRatingLikeStates(ctx.supabase, ratingTargets),
      getRatingCommentStates(ctx.supabase, ratingTargets),
    ]);
    const likesByKey = new Map(
      likeStates.map((s) => [`${s.username}:${s.mediaType}:${s.tmdbId}`, s]),
    );
    const commentsByKey = new Map(
      commentStates.map((s) => [`${s.username}:${s.mediaType}:${s.tmdbId}`, s]),
    );
    for (const event of items) {
      if (event.type !== "rating") continue;
      const key = `${event.actor.username}:${event.title.mediaType}:${event.title.tmdbId}`;
      const likeState = likesByKey.get(key);
      if (likeState) {
        event.likeCount = likeState.likeCount;
        event.likedByViewer = likeState.likedByViewer;
      }
      const commentState = commentsByKey.get(key);
      if (commentState) {
        event.commentCount = commentState.commentCount;
        event.commentsEnabled = commentState.commentsEnabled;
      }
    }
  }

  const hasMore = Array.isArray(probe.data) && probe.data.length > 0;
  return { items: items.slice(0, size), page, hasMore };
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getFeedSession(
  request: Request,
  cookies: AstroCookies,
): Promise<FeedContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
