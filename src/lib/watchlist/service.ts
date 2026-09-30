/**
 * Camada server-side da Minha Lista (RLS como enforcement).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário-alvo sempre vem da sessão autenticada (`auth.getUser()`).
 *   O browser NUNCA envia user_id.
 * - O client server-side age com o JWT do usuário: as políticas RLS
 *   (`auth.uid() = user_id`) valem em cada query.
 * - TMDB é a fonte factual: `addToWatchlist` confirma a existência do
 *   título no TMDB server-side e extrai title/poster_path/release_year
 *   de lá. Snapshots no banco servem só para renderização eficiente.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import { getCurrentUser } from "../supabase/server";
import { fetchTitleSnapshot, TitleNotFoundError } from "../tmdb/snapshot";
import type { WatchlistInput, WatchlistItem } from "./types";

export { TitleNotFoundError };

/** Shape raw da tabela public.watchlist (interno a este módulo). */
interface WatchlistRow {
  user_id: string;
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
  created_at: string;
}

const WATCHLIST_COLUMNS =
  "tmdb_id, media_type, title, poster_path, release_year, created_at";

function toWatchlistItem(row: WatchlistRow): WatchlistItem {
  return {
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    title: row.title,
    posterPath: row.poster_path,
    ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
    createdAt: row.created_at,
  };
}

export interface WatchlistContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Lista do usuário DA SESSÃO, mais recentes primeiro (created_at DESC).
 * Sem paginação nesta etapa (lista pessoal típica é pequena).
 */
export async function getUserWatchlist(
  ctx: WatchlistContext,
): Promise<WatchlistItem[]> {
  const { data, error } = await ctx.supabase
    .from("watchlist")
    .select(WATCHLIST_COLUMNS)
    .eq("user_id", ctx.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error("[Watchlist] Falha ao carregar lista.");
  }

  return ((data ?? []) as WatchlistRow[]).map(toWatchlistItem);
}

/**
 * Contador eficiente (sem carregar a lista) para o hub /perfil.
 * Respeita RLS como qualquer outra query do usuário.
 */
export async function getWatchlistCount(
  ctx: WatchlistContext,
): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("watchlist")
    .select("*", { count: "exact", head: true })
    .eq("user_id", ctx.user.id);

  if (error) {
    throw new Error("[Watchlist] Falha ao contar lista.");
  }

  return count ?? 0;
}

/** O título já está na lista do usuário DA SESSÃO? */
export async function isInWatchlist(
  ctx: WatchlistContext,
  input: WatchlistInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("watchlist")
    .select("tmdb_id")
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .maybeSingle();

  if (error) {
    throw new Error("[Watchlist] Falha ao verificar lista.");
  }

  return data !== null;
}

/**
 * Adiciona (idempotente: INSERT + fallback SELECT na violação de unicidade).
 * O user_id vem da sessão; title/poster/year vêm do TMDB.
 *
 * Sem upsert de propósito: a tabela não tem política de UPDATE (snapshot
 * só muda via DELETE + POST), e um upsert no conflito tentaria UPDATE,
 * bloqueado pelo RLS. Re-adicionar retorna a linha existente (200, 1 linha).
 */
export async function addToWatchlist(
  ctx: WatchlistContext,
  input: WatchlistInput,
): Promise<WatchlistItem> {
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
    .from("watchlist")
    .insert(payload)
    .select(WATCHLIST_COLUMNS)
    .single();

  if (!error && data) {
    return toWatchlistItem(data as WatchlistRow);
  }

  // Conflito na identidade única (user+type+id): re-adicionar é idempotente,
  // retorna a linha existente sem tentar UPDATE (sem política de UPDATE).
  if (error && (error as { code?: string }).code === "23505") {
    const { data: existing, error: selectError } = await ctx.supabase
      .from("watchlist")
      .select(WATCHLIST_COLUMNS)
      .eq("user_id", ctx.user.id)
      .eq("media_type", input.mediaType)
      .eq("tmdb_id", input.tmdbId)
      .single();

    if (!selectError && existing) {
      return toWatchlistItem(existing as WatchlistRow);
    }
  }

  throw new Error("[Watchlist] Falha ao salvar na lista.");
}

/** Remove. Retorna `true` se algo foi removido. */
export async function removeFromWatchlist(
  ctx: WatchlistContext,
  input: WatchlistInput,
): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("watchlist")
    .delete()
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .select("tmdb_id");

  if (error) {
    throw new Error("[Watchlist] Falha ao remover da lista.");
  }

  return Array.isArray(data) && data.length > 0;
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getWatchlistSession(
  request: Request,
  cookies: AstroCookies,
): Promise<WatchlistContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
