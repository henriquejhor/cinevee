/**
 * Camada server-side das seleções do Sobre (RLS como enforcement).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário-alvo sempre vem da sessão autenticada (`auth.getUser()`).
 *   O browser NUNCA envia user_id.
 * - O client server-side age com o JWT do usuário: as políticas RLS
 *   (`auth.uid() = user_id`) valem em cada query.
 * - TMDB é a fonte factual: `addProfilePick` confirma a existência do
 *   título no TMDB server-side (fetchTitleSnapshot) e extrai
 *   title/poster_path/release_year de lá. Snapshots servem só para
 *   renderização eficiente (sem 1 request TMDB por pick).
 * - Picks são independentes: NÃO exigem watched, rating ou review.
 * - Limites (12 favoritos / 6 recomendações) com enforcement server-side.
 * - Posições determinísticas 0..n-1 por seção (compactadas na remoção).
 * - TasteProfile NÃO consome picks (só ratings).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import { getCurrentUser } from "../supabase/server";
import { fetchTitleSnapshot, TitleNotFoundError } from "../tmdb/snapshot";
import {
  pickLimitFor,
  type AddPickInput,
  type ProfilePick,
  type ProfilePickKind,
} from "./types";

export { TitleNotFoundError };

/** Título já está na mesma seção → 409 amigável (nunca SQL bruto). */
export class DuplicatePickError extends Error {
  constructor(kind: ProfilePickKind) {
    super(
      kind === "favorite"
        ? "Este título já está nos seus favoritos."
        : "Este título já está nas suas recomendações.",
    );
    this.name = "DuplicatePickError";
  }
}

/** Seção cheia → 409 amigável (botão desabilitado é só cosmético). */
export class PickLimitError extends Error {
  constructor(kind: ProfilePickKind) {
    super(
      kind === "favorite"
        ? "Você pode escolher até 12 favoritos."
        : "Você pode recomendar até 6 títulos.",
    );
    this.name = "PickLimitError";
  }
}

/** Pick inexistente (ou de outro usuário, via RLS) → 404 amigável. */
export class PickNotFoundError extends Error {
  constructor() {
    super("Seleção não encontrada.");
    this.name = "PickNotFoundError";
  }
}

/** Shape raw da tabela public.profile_picks (interno a este módulo). */
interface ProfilePickRow {
  id: string;
  user_id: string;
  tmdb_id: number;
  media_type: string;
  kind: string;
  title: string;
  poster_path: string | null;
  release_year: number | null;
  note: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

const PICKS_COLUMNS =
  "id, tmdb_id, media_type, kind, title, poster_path, release_year, note, position, created_at, updated_at";

function toProfilePick(row: ProfilePickRow): ProfilePick {
  return {
    id: row.id,
    tmdbId: Number(row.tmdb_id),
    mediaType: row.media_type as ContentType,
    kind: row.kind as ProfilePickKind,
    title: row.title,
    posterPath: row.poster_path,
    ...(typeof row.release_year === "number" ? { year: row.release_year } : {}),
    note: typeof row.note === "string" ? row.note : null,
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ProfilePicksContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Picks do usuário DA SESSÃO, ordenados por posição (ordem manual).
 * `kind` opcional filtra a seção. Nunca faz request TMDB (snapshots).
 */
export async function getProfilePicks(
  ctx: ProfilePicksContext,
  kind?: ProfilePickKind,
): Promise<ProfilePick[]> {
  let query = ctx.supabase
    .from("profile_picks")
    .select(PICKS_COLUMNS)
    .eq("user_id", ctx.user.id);

  if (kind) {
    query = query.eq("kind", kind);
  }

  const { data, error } = await query.order("position", { ascending: true });

  if (error) {
    throw new Error("[ProfilePicks] Falha ao carregar seleções.");
  }

  return ((data ?? []) as ProfilePickRow[]).map(toProfilePick);
}

/** Atalho: favoritos ordenados (preview da overview usa os primeiros). */
export async function getFavorites(
  ctx: ProfilePicksContext,
): Promise<ProfilePick[]> {
  return getProfilePicks(ctx, "favorite");
}

/** Atalho: recomendações ordenadas. */
export async function getRecommendations(
  ctx: ProfilePicksContext,
): Promise<ProfilePick[]> {
  return getProfilePicks(ctx, "recommendation");
}

/**
 * Adiciona à seção (valida TMDB server-side, salva snapshot factual).
 * Duplicata na mesma seção → DuplicatePickError (409 amigável, inclusive
 * em corrida via código 23505). Seção cheia → PickLimitError.
 * O mesmo título pode coexistir como favorite + recommendation.
 */
export async function addProfilePick(
  ctx: ProfilePicksContext,
  input: AddPickInput,
): Promise<ProfilePick> {
  const { data: existing, error: existingError } = await ctx.supabase
    .from("profile_picks")
    .select("id")
    .eq("user_id", ctx.user.id)
    .eq("media_type", input.mediaType)
    .eq("tmdb_id", input.tmdbId)
    .eq("kind", input.kind)
    .maybeSingle();

  if (existingError) {
    throw new Error("[ProfilePicks] Falha ao salvar seleção.");
  }
  if (existing) {
    throw new DuplicatePickError(input.kind);
  }

  const { count, error: countError } = await ctx.supabase
    .from("profile_picks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ctx.user.id)
    .eq("kind", input.kind);

  if (countError) {
    throw new Error("[ProfilePicks] Falha ao salvar seleção.");
  }
  if ((count ?? 0) >= pickLimitFor(input.kind)) {
    throw new PickLimitError(input.kind);
  }

  // TMDB valida a existência; title/poster/year vêm de lá (nunca do body).
  const snapshot = await fetchTitleSnapshot({
    tmdbId: input.tmdbId,
    mediaType: input.mediaType,
  });

  // Próxima posição = fim da seção (posições compactadas 0..n-1).
  const { data: tail, error: tailError } = await ctx.supabase
    .from("profile_picks")
    .select("position")
    .eq("user_id", ctx.user.id)
    .eq("kind", input.kind)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (tailError) {
    throw new Error("[ProfilePicks] Falha ao salvar seleção.");
  }
  const nextPosition =
    tail && typeof (tail as { position: unknown }).position === "number"
      ? Number((tail as { position: number }).position) + 1
      : 0;

  const { data, error } = await ctx.supabase
    .from("profile_picks")
    .insert({
      user_id: ctx.user.id,
      tmdb_id: input.tmdbId,
      media_type: input.mediaType,
      kind: input.kind,
      title: snapshot.title,
      poster_path: snapshot.posterPath,
      release_year: snapshot.year ?? null,
      // Favorito nunca tem nota; recommendation chega normalizada (1–500).
      note: input.kind === "recommendation" ? (input.note ?? null) : null,
      position: nextPosition,
      updated_at: new Date().toISOString(),
    })
    .select(PICKS_COLUMNS)
    .single();

  if (!error && data) {
    return toProfilePick(data as ProfilePickRow);
  }

  // Corrida: outra request inseriu o mesmo item primeiro.
  if (error && (error as { code?: string }).code === "23505") {
    throw new DuplicatePickError(input.kind);
  }

  throw new Error("[ProfilePicks] Falha ao salvar seleção.");
}

/**
 * Remove da seção (só aquele kind — o mesmo título na outra seção continua).
 * Compacta as posições restantes (0..n-1). Retorna a pick removida
 * (`null` quando nada foi removido).
 */
export async function removeProfilePick(
  ctx: ProfilePicksContext,
  id: string,
): Promise<ProfilePick | null> {
  const { data, error } = await ctx.supabase
    .from("profile_picks")
    .delete()
    .eq("user_id", ctx.user.id)
    .eq("id", id)
    .select(PICKS_COLUMNS);

  if (error) {
    throw new Error("[ProfilePicks] Falha ao remover seleção.");
  }
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const removed = toProfilePick(data[0] as ProfilePickRow);
  await compactPositions(ctx, removed.kind);
  return removed;
}

/** Compacta posições da seção (0..n-1, mesma ordem relativa). */
async function compactPositions(
  ctx: ProfilePicksContext,
  kind: ProfilePickKind,
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from("profile_picks")
    .select("id")
    .eq("user_id", ctx.user.id)
    .eq("kind", kind)
    .order("position", { ascending: true });

  if (error || !data) return;

  let position = 0;
  for (const row of data as { id: string }[]) {
    const { error: updateError } = await ctx.supabase
      .from("profile_picks")
      .update({ position, updated_at: new Date().toISOString() })
      .eq("user_id", ctx.user.id)
      .eq("id", row.id);
    if (updateError) break;
    position += 1;
  }
}

/**
 * Edita a justificativa (só recommendation; preserva a posição).
 * Pick inexistente ou favorita → PickNotFoundError (404 amigável).
 */
export async function updateRecommendationNote(
  ctx: ProfilePicksContext,
  id: string,
  note: string,
): Promise<ProfilePick> {
  const { data: current, error: currentError } = await ctx.supabase
    .from("profile_picks")
    .select(PICKS_COLUMNS)
    .eq("user_id", ctx.user.id)
    .eq("id", id)
    .maybeSingle();

  if (currentError) {
    throw new Error("[ProfilePicks] Falha ao salvar recomendação.");
  }
  if (!current || (current as ProfilePickRow).kind !== "recommendation") {
    throw new PickNotFoundError();
  }

  const { data, error } = await ctx.supabase
    .from("profile_picks")
    .update({ note, updated_at: new Date().toISOString() })
    .eq("user_id", ctx.user.id)
    .eq("id", id)
    .select(PICKS_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error("[ProfilePicks] Falha ao salvar recomendação.");
  }

  return toProfilePick(data as ProfilePickRow);
}

/**
 * Reordena a seção (ordem manual completa, sem misturar kinds).
 * `orderedIds` deve conter EXATAMENTE as picks atuais da seção
 * (sem ids alheios, sem faltar, sem repetir) — array arbitrário é 400.
 * Nunca aceita ids de outro usuário (filtro por sessão + comparação).
 */
export async function reorderProfilePicks(
  ctx: ProfilePicksContext,
  kind: ProfilePickKind,
  orderedIds: string[],
): Promise<ProfilePick[]> {
  const { data: current, error: currentError } = await ctx.supabase
    .from("profile_picks")
    .select("id")
    .eq("user_id", ctx.user.id)
    .eq("kind", kind)
    .order("position", { ascending: true });

  if (currentError || !current) {
    throw new Error("[ProfilePicks] Falha ao reordenar.");
  }

  const currentIds = (current as { id: string }[]).map((row) => row.id);
  const currentSet = new Set(currentIds);

  if (
    orderedIds.length !== currentIds.length ||
    !orderedIds.every((id) => currentSet.has(id))
  ) {
    throw new PickNotFoundError();
  }

  for (let position = 0; position < orderedIds.length; position += 1) {
    const { error: updateError } = await ctx.supabase
      .from("profile_picks")
      .update({ position, updated_at: new Date().toISOString() })
      .eq("user_id", ctx.user.id)
      .eq("id", orderedIds[position])
      .eq("kind", kind);

    if (updateError) {
      throw new Error("[ProfilePicks] Falha ao reordenar.");
    }
  }

  return getProfilePicks(ctx, kind);
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getProfilePicksSession(
  request: Request,
  cookies: AstroCookies,
): Promise<ProfilePicksContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}
