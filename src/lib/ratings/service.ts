/**
 * Camada server-side das Avaliações (RLS como enforcement).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário-alvo sempre vem da sessão autenticada (`auth.getUser()`).
 *   O browser NUNCA envia user_id.
 * - O client server-side age com o JWT do usuário: as políticas RLS
 *   (`auth.uid() = user_id`) valem em cada query.
 * - Avaliação só existe para título assistido: `setRating` verifica
 *   watched_titles antes e retorna erro amigável (a FK também barraria,
 *   mas nunca expomos erro SQL bruto).
 * - ratings NÃO guarda title/poster/year: `getUserRatings` junta com
 *   watched_titles para montar o `RatedTitle` visual.
 * - POST cria ou altera (upsert seguro: a tabela TEM policy de UPDATE).
 * - Opinião textual (Etapa 12): `review_text` vive na mesma row — sem
 *   tabela extra, sem query extra, sem sinal para o TasteProfile.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import { getCurrentUser } from "../supabase/server";
import type { RatedTitle, RatingInput, RatingKey, UserRating } from "./types";

/** Erro amigável quando o título ainda não foi assistido (→ 409). */
export class NotWatchedError extends Error {
  constructor() {
    super("Marque este título como assistido antes de avaliá-lo.");
    this.name = "NotWatchedError";
  }
}

/** Erro amigável quando não há rating para ancorar a opinião (→ 404). */
export class ReviewRequiresRatingError extends Error {
  constructor() {
    super("Avalie com estrelas antes de escrever sua opinião.");
    this.name = "ReviewRequiresRatingError";
  }
}

/** Shape raw da tabela public.ratings (interno a este módulo). */
interface RatingRow {
  user_id: string;
  tmdb_id: number;
  media_type: string;
  rating: number;
  review_text: string | null;
  rated_at: string;
  updated_at: string;
}

/** Shape raw de watched_titles para o join visual (interno). */
interface WatchedVisualRow {
  tmdb_id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
}

const RATINGS_COLUMNS = "tmdb_id, media_type, rating, review_text, rated_at, updated_at";

function toUserRating(row: RatingRow): UserRating {
  return {
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    rating: Number(row.rating),
    reviewText: typeof row.review_text === "string" ? row.review_text : null,
    ratedAt: row.rated_at,
    updatedAt: row.updated_at,
  };
}

export interface RatingsContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Avaliações do usuário DA SESSÃO com os dados visuais do título,
 * mais recentemente avaliadas primeiro (updated_at DESC).
 */
export async function getUserRatings(
  ctx: RatingsContext,
): Promise<RatedTitle[]> {
  const { data: ratings, error } = await ctx.supabase
    .from("ratings")
    .select(RATINGS_COLUMNS)
    .eq("user_id", ctx.user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw new Error("[Ratings] Falha ao carregar avaliações.");
  }

  const rows = (ratings ?? []) as RatingRow[];
  if (rows.length === 0) return [];

  const { data: watched, error: watchedError } = await ctx.supabase
    .from("watched_titles")
    .select("tmdb_id, media_type, title, poster_path, release_year")
    .eq("user_id", ctx.user.id);

  if (watchedError) {
    throw new Error("[Ratings] Falha ao carregar avaliações.");
  }

  const visual = new Map(
    ((watched ?? []) as WatchedVisualRow[]).map((w) => [
      `${w.media_type}:${Number(w.tmdb_id)}`,
      w,
    ]),
  );

  const items: RatedTitle[] = [];
  for (const row of rows) {
    const w = visual.get(`${row.media_type}:${Number(row.tmdb_id)}`);
    if (!w) continue; // Sem visual correspondente — não exibir linha órfã.
    items.push({
      ...toUserRating(row),
      title: w.title,
      posterPath: w.poster_path,
      ...(typeof w.release_year === "number" ? { year: w.release_year } : {}),
    });
  }

  return items;
}

/** Atalho: N recentes (preview da visão geral). Padrão: 5. */
export async function getRecentRatings(
  ctx: RatingsContext,
  limit = 5,
): Promise<RatedTitle[]> {
  const items = await getUserRatings(ctx);
  return items.slice(0, limit);
}

/**
 * Contador eficiente (sem carregar a lista) para o hub /perfil.
 * Respeita RLS como qualquer outra query do usuário.
 */
export async function getRatingsCount(ctx: RatingsContext): Promise<number> {
  const { count, error } = await ctx.supabase
    .from("ratings")
    .select("*", { count: "exact", head: true })
    .eq("user_id", ctx.user.id);

  if (error) {
    throw new Error("[Ratings] Falha ao contar avaliações.");
  }

  return count ?? 0;
}

/** A nota atual do usuário DA SESSÃO para o título (`null` = sem nota). */
export async function getRatingForTitle(
  ctx: RatingsContext,
  key: RatingKey,
): Promise<UserRating | null> {
  const { data, error } = await ctx.supabase
    .from("ratings")
    .select(RATINGS_COLUMNS)
    .eq("user_id", ctx.user.id)
    .eq("media_type", key.mediaType)
    .eq("tmdb_id", key.tmdbId)
    .maybeSingle();

  if (error) {
    throw new Error("[Ratings] Falha ao verificar avaliação.");
  }

  return data ? toUserRating(data as RatingRow) : null;
}

/**
 * Cria ou altera a avaliação (upsert na identidade única).
 * Exige o título em watched_titles do usuário (erro amigável senão).
 * `updated_at` é renovado a cada escrita (trigger como garantia).
 *
 * Opinião (Etapa 12): `input.reviewText === undefined` (campo omitido)
 * preserva a opinião existente — trocar estrelas nunca apaga o texto.
 * `null` limpa a opinião mantendo a nota. Review nunca existe sem rating.
 */
export async function setRating(
  ctx: RatingsContext,
  input: RatingInput,
): Promise<UserRating> {
  const { data: watched, error: watchedError } = await ctx.supabase
    .from("watched_titles")
    .select("tmdb_id")
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .maybeSingle();

  if (watchedError) {
    throw new Error("[Ratings] Falha ao salvar avaliação.");
  }
  if (!watched) {
    throw new NotWatchedError();
  }

  // Preserva a opinião quando o browser não enviou o campo (compat com
  // chamadas antigas { tmdbId, mediaType, rating }).
  let reviewText: string | null | undefined = input.reviewText;
  if (reviewText === undefined) {
    const { data: current, error: currentError } = await ctx.supabase
      .from("ratings")
      .select("review_text")
      .eq("user_id", ctx.user.id)
      .eq("media_type", input.mediaType)
      .eq("tmdb_id", input.tmdbId)
      .maybeSingle();
    if (currentError) {
      throw new Error("[Ratings] Falha ao salvar avaliação.");
    }
    reviewText =
      current && typeof (current as { review_text: unknown }).review_text === "string"
        ? (current as { review_text: string }).review_text
        : null;
    // Linha inexistente → NULL (sem opinião); existente sem coluna
    // migrada → NULL (a coluna chega via migration da Etapa 12).
  }

  const { data, error } = await ctx.supabase
    .from("ratings")
    .upsert(
      {
        user_id: ctx.user.id,
        tmdb_id: input.tmdbId,
        media_type: input.mediaType,
        rating: input.rating,
        review_text: reviewText,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,media_type,tmdb_id" },
    )
    .select(RATINGS_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error("[Ratings] Falha ao salvar avaliação.");
  }

  return toUserRating(data as RatingRow);
}

/**
 * Cria/atualiza/remove SÓ a opinião, sem tocar nas estrelas.
 * Exige rating existente (review depende de rating — → 404 amigável).
 * `reviewText: null` remove a opinião e mantém a nota.
 */
export async function updateReview(
  ctx: RatingsContext,
  key: RatingKey,
  reviewText: string | null,
): Promise<UserRating> {
  const { data: current, error: currentError } = await ctx.supabase
    .from("ratings")
    .select(RATINGS_COLUMNS)
    .eq("user_id", ctx.user.id)
    .eq("media_type", key.mediaType)
    .eq("tmdb_id", key.tmdbId)
    .maybeSingle();

  if (currentError) {
    throw new Error("[Ratings] Falha ao salvar sua opinião.");
  }
  if (!current) {
    throw new ReviewRequiresRatingError();
  }

  const { data, error } = await ctx.supabase
    .from("ratings")
    .update({
      review_text: reviewText,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", ctx.user.id)
    .eq("media_type", key.mediaType)
    .eq("tmdb_id", key.tmdbId)
    .select(RATINGS_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error("[Ratings] Falha ao salvar sua opinião.");
  }

  return toUserRating(data as RatingRow);
}

/**
 * Remove a avaliação. NÃO apaga o título de Assistidos.
 * Retorna `true` se algo foi removido.
 */
export async function removeRating(
  ctx: RatingsContext,
  key: RatingKey,
): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from("ratings")
    .delete()
    .eq("user_id", ctx.user.id)
    .eq("media_type", key.mediaType)
    .eq("tmdb_id", key.tmdbId)
    .select("tmdb_id");

  if (error) {
    throw new Error("[Ratings] Falha ao remover avaliação.");
  }

  return Array.isArray(data) && data.length > 0;
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getRatingsSession(
  request: Request,
  cookies: AstroCookies,
): Promise<RatingsContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
