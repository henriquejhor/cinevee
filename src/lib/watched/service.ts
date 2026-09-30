/**
 * Camada server-side dos Assistidos / Já assisti (RLS como enforcement).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário-alvo sempre vem da sessão autenticada (`auth.getUser()`).
 *   O browser NUNCA envia user_id.
 * - O client server-side age com o JWT do usuário: as políticas RLS
 *   (`auth.uid() = user_id`) valem em cada query.
 * - TMDB é a fonte factual: `markAsWatched` confirma a existência do
 *   título no TMDB server-side (helper compartilhado) e extrai
 *   title/poster_path/release_year de lá.
 * - Ao marcar como assistido, o mesmo item é removido da watchlist
 *   (se estiver lá). Desmarcar NÃO recria a watchlist.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import { getCurrentUser } from "../supabase/server";
import { fetchTitleSnapshot, TitleNotFoundError } from "../tmdb/snapshot";
import type { WatchedInput, WatchedTitle } from "./types";

export { TitleNotFoundError };

/** Shape raw da tabela public.watched_titles (interno a este módulo). */
interface WatchedRow {
  user_id: string;
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
  watched_at: string;
}

const WATCHED_COLUMNS =
  "tmdb_id, media_type, title, poster_path, release_year, watched_at";

function toWatchedTitle(row: WatchedRow): WatchedTitle {
  return {
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    title: row.title,
    posterPath: row.poster_path,
    ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
    watchedAt: row.watched_at,
  };
}

export interface WatchedContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Assistidos do usuário DA SESSÃO, mais recentes primeiro (watched_at DESC).
 * Sem paginação nesta etapa (histórico pessoal típico é pequeno).
 */
export async function getUserWatchedTitles(
  ctx: WatchedContext,
): Promise<WatchedTitle[]> {
  const { data, error } = await ctx.supabase
    .from("watched_titles")
    .select(WATCHED_COLUMNS)
    .eq("user_id", ctx.user.id)
    .order("watched_at", { ascending: false });

  if (error) {
    throw new Error("[Watched] Falha ao carregar assistidos.");
  }

  return ((data ?? []) as WatchedRow[]).map(toWatchedTitle);
}

/** Atalho: N recentes (preview da visão geral). Padrão: 6. */
export async function getRecentWatchedTitles(
  ctx: WatchedContext,
  limit = 6,
): Promise<WatchedTitle[]> {
  const items = await getUserWatchedTitles(ctx);
  return items.slice(0, limit);
}

/**
 * Contador eficiente (sem carregar a lista) para o hub /perfil.
 * Respeita RLS como qualquer outra query do usuário.
 */
export async function getWatchedCount(ctx: WatchedContext): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("watched_titles")
    .select("*", { count: "exact", head: true })
    .eq("user_id", ctx.user.id);

  if (error) {
    throw new Error("[Watched] Falha ao contar assistidos.");
  }

  return count ?? 0;
}

/** O título já está marcado como assistido pelo usuário DA SESSÃO? */
export async function isWatched(
  ctx: WatchedContext,
  input: WatchedInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("watched_titles")
    .select("tmdb_id")
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .maybeSingle();

  if (error) {
    throw new Error("[Watched] Falha ao verificar assistidos.");
  }

  return data !== null;
}

export interface MarkAsWatchedResult {
  item: WatchedTitle;
  /** `true` quando o item também saiu da Minha Lista. */
  removedFromWatchlist: boolean;
}

/**
 * Marca como assistido (idempotente: INSERT + fallback SELECT na violação
 * de unicidade), depois remove o mesmo item da watchlist (best-effort).
 *
 * Ordem: 1. confirma TMDB → 2. insere em watched_titles →
 * 3. remove da watchlist se existir. A watchlist NUNCA é removida antes
 * de garantir o registro em assistidos; se a remoção da watchlist falhar,
 * o assistido permanece (sem rollback automático, sem overengineering).
 *
 * Sem upsert de propósito: a tabela não tem política de UPDATE, e um
 * upsert no conflito tentaria UPDATE, bloqueado pelo RLS.
 */
export async function markAsWatched(
  ctx: WatchedContext,
  input: WatchedInput,
): Promise<MarkAsWatchedResult> {
  const snapshot = await fetchTitleSnapshot(input);

  const payload = {
    user_id: ctx.user.id,
    tmdb_id: input.tmdbId,
    media_type: input.mediaType,
    title: snapshot.title,
    poster_path: snapshot.posterPath,
    release_year: snapshot.year ?? null,
  };

  const { data, error } = await ctx.supabase
    .from("watched_titles")
    .insert(payload)
    .select(WATCHED_COLUMNS)
    .single();

  let item: WatchedTitle | null = null;

  if (!error && data) {
    item = toWatchedTitle(data as WatchedRow);
  } else if (error && (error as { code?: string }).code === "23505") {
    // Conflito na identidade única (user+type+id): re-marcar é idempotente,
    // retorna a linha existente sem tentar UPDATE (sem política de UPDATE).
    const { data: existing, error: selectError } = await ctx.supabase
      .from("watched_titles")
      .select(WATCHED_COLUMNS)
      .eq("user_id", ctx.user.id)
      .eq("media_type", input.mediaType)
      .eq("tmdb_id", input.tmdbId)
      .single();

    if (!selectError && existing) {
      item = toWatchedTitle(existing as WatchedRow);
    }
  }

  if (!item) {
    throw new Error("[Watched] Falha ao marcar como assistido.");
  }

  // Sai da Minha Lista (se estiver lá). Falha aqui não desfaz o assistido.
  let removedFromWatchlist = false;
  try {
    const { data: removed, error: watchError } = await ctx.supabase
      .from("watchlist")
      .delete()
      .eq("user_id", ctx.user.id)
      .eq("media_type", input.mediaType)
      .eq("tmdb_id", input.tmdbId)
      .select("tmdb_id");
    removedFromWatchlist =
      !watchError && Array.isArray(removed) && removed.length > 0;
    if (watchError) {
      console.error("[Watched] Assistido salvo; remoção da watchlist falhou.");
    }
  } catch {
    console.error("[Watched] Assistido salvo; remoção da watchlist falhou.");
  }

  return { item, removedFromWatchlist };
}

/**
 * Desmarca como assistido. Remove SOMENTE de watched_titles —
 * NÃO recria a watchlist. Retorna `true` se algo foi removido.
 */
export async function removeFromWatched(
  ctx: WatchedContext,
  input: WatchedInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("watched_titles")
    .delete()
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .select("tmdb_id");

  if (error) {
    throw new Error("[Watched] Falha ao remover dos assistidos.");
  }

  return Array.isArray(data) && data.length > 0;
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getWatchedSession(
  request: Request,
  cookies: AstroCookies,
): Promise<WatchedContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
