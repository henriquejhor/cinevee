/**
 * Camada server-side de comentários em avaliações (Etapa 19).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - Tudo passa pelas RPCs (SECURITY DEFINER, auth.uid() interno). O
 *   browser NUNCA envia author_id/owner_id e NUNCA usa
 *   .from("rating_comments") diretamente.
 * - Erro genérico "Esta avaliação não está disponível." para
 *   privado/escondido/inexistente (sem oracle); self e desativado têm
 *   mensagens próprias (→ 409/403). Erro SQL real vai para o log
 *   server-side (nunca para o browser).
 * - Thread e counts/summary em batch (sem N+1). Comentários NÃO entram
 *   em TasteProfile/ranking/feed-event (nenhum import cruza p/ lá).
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import type { ContentType } from "../../types/content";
import type {
  RatingComment,
  RatingCommentPage,
  RatingCommentState,
  RatingCommentTarget,
} from "./types";
import {
  RATING_COMMENT_BATCH_SIZE,
  RATING_COMMENT_DEFAULT_LIMIT,
} from "./types";

const AVATAR_BUCKET = "avatars";

/** Alvo privado/escondido/inexistente → 404 genérico. */
export class RatingCommentNotAvailableError extends Error {
  constructor() {
    super("Esta avaliação não está disponível.");
    this.name = "RatingCommentNotAvailableError";
  }
}

/** Novos comentários desativados pelo dono → 403. */
export class RatingCommentsDisabledError extends Error {
  constructor() {
    super("Novos comentários estão desativados nesta avaliação.");
    this.name = "RatingCommentsDisabledError";
  }
}

/** Dono tentando comentar a própria rating → 409 (CHECK no DB). */
export class SelfCommentError extends Error {
  constructor() {
    super("Você não pode comentar sua própria avaliação.");
    this.name = "SelfCommentError";
  }
}

/** Comentário inexistente/sem permissão → 404 genérico. */
export class CommentNotAvailableError extends Error {
  constructor() {
    super("Comentário indisponível.");
    this.name = "CommentNotAvailableError";
  }
}

export interface RatingCommentsContext {
  supabase: SupabaseClient;
  user: User;
}

export interface RatingCommentsViewer {
  supabase: SupabaseClient;
  /** NULL = anônimo (só leitura pública). */
  user: User | null;
}

const SELF_MESSAGE = "Você não pode comentar sua própria avaliação.";
const DISABLED_MESSAGE = "Novos comentários estão desativados nesta avaliação.";
const UNAVAILABLE_MESSAGE = "Esta avaliação não está disponível.";
const COMMENT_UNAVAILABLE_MESSAGE = "Comentário indisponível.";

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function avatarPublicUrl(
  supabase: SupabaseClient,
  avatarPath: string | null,
): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

function toComment(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): RatingComment | null {
  const commentId = toPositiveInt(row.comment_id);
  if (commentId === null) return null;
  if (typeof row.comment_text !== "string") return null;
  if (typeof row.created_at !== "string" || Number.isNaN(Date.parse(row.created_at))) {
    return null;
  }
  if (typeof row.updated_at !== "string" || Number.isNaN(Date.parse(row.updated_at))) {
    return null;
  }
  const isPrivate = row.author_is_private !== false;
  const username =
    !isPrivate && typeof row.author_username === "string" && row.author_username.length > 0
      ? row.author_username
      : null;
  const createdMs = Date.parse(row.created_at);
  const updatedMs = Date.parse(row.updated_at);
  return {
    commentId,
    author: {
      isPrivate,
      displayName:
        !isPrivate && typeof row.author_display_name === "string"
          ? row.author_display_name
          : null,
      username,
      avatarUrl:
        !isPrivate && typeof row.author_avatar_path === "string"
          ? avatarPublicUrl(supabase, row.author_avatar_path)
          : null,
    },
    text: row.comment_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: updatedMs - createdMs > 1000,
    canEdit: row.can_edit === true,
    canDelete: row.can_delete === true,
    replyCount: toCount(row.reply_count),
  };
}

/**
 * Thread paginada (principal + sonda hasMore, em paralelo).
 * Gate: batch-state primeiro — alvo escondido/inexistente → 404 sem
 * oracle (a RPC de lista retorna 0 rows nos dois casos). Anon lê;
 * canComment/isOwner vêm da sessão + flags (sem UUID no client).
 */
export async function listRatingComments(
  viewer: RatingCommentsViewer,
  target: RatingCommentTarget,
  page: number,
  limit: number,
): Promise<RatingCommentPage> {
  const states = await getRatingCommentStates(viewer.supabase, [target]);
  const state = states[0] ?? null;
  if (!state) {
    throw new RatingCommentNotAvailableError();
  }

  const offset = (page - 1) * limit;
  const [main, probe] = await Promise.all([
    viewer.supabase.rpc("get_public_rating_comments", {
      p_username: target.username,
      p_tmdb_id: target.tmdbId,
      p_media_type: target.mediaType,
      p_limit: limit,
      p_offset: offset,
    }),
    viewer.supabase.rpc("get_public_rating_comments", {
      p_username: target.username,
      p_tmdb_id: target.tmdbId,
      p_media_type: target.mediaType,
      p_limit: 1,
      p_offset: offset + limit,
    }),
  ]);

  if (main.error || !Array.isArray(main.data)) {
    throw new Error("[RatingComments] Falha ao listar comentários.");
  }

  const items: RatingComment[] = [];
  let isOwner = false;
  for (const row of main.data as Array<Record<string, unknown>>) {
    if (!row || typeof row !== "object") continue;
    if (row.viewer_is_owner === true) isOwner = true;
    const comment = toComment(viewer.supabase, row);
    if (comment) items.push(comment);
  }

  const hasMore = Array.isArray(probe.data) && probe.data.length > 0;
  const canComment =
    viewer.user !== null && !isOwner && state.commentsEnabled;
  return {
    items: items.slice(0, limit),
    page,
    pageSize: limit,
    hasMore,
    commentCount: state.commentCount,
    commentsEnabled: state.commentsEnabled,
    isOwner,
    canComment,
  };
}

/** Cria um comentário (viewer logado, não-owner, thread habilitada). */
export async function createRatingComment(
  ctx: RatingCommentsContext,
  target: RatingCommentTarget,
  text: string,
): Promise<{ comment: RatingComment; commentCount: number }> {
  const { data, error } = await ctx.supabase.rpc(
    "create_rating_comment_by_username",
    {
      p_username: target.username,
      p_tmdb_id: target.tmdbId,
      p_media_type: target.mediaType,
      p_comment_text: text,
    },
  );

  if (error) {
    console.error("[RatingComments] create_rating_comment_by_username falhou:", error);
    if (error.message === SELF_MESSAGE) throw new SelfCommentError();
    if (error.message === DISABLED_MESSAGE) throw new RatingCommentsDisabledError();
    // Só a mensagem conhecida de indisponibilidade vira 404. Erro SQL
    // inesperado (ex.: 42702) NÃO pode ser mascarado como "alvo
    // indisponível" (aprendizado Etapa 16): vira 500 genérico.
    if (error.message === UNAVAILABLE_MESSAGE) {
      throw new RatingCommentNotAvailableError();
    }
    throw new Error("[RatingComments] Falha ao criar comentário.");
  }

  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  const comment = row ? toComment(ctx.supabase, row) : null;
  if (!comment) {
    throw new Error("[RatingComments] Resposta de criação inválida.");
  }
  return { comment, commentCount: toCount(row?.comment_count) };
}

/** Edita o próprio comentário (só o autor; thread pode estar fechada). */
export async function updateRatingComment(
  ctx: RatingCommentsContext,
  commentId: number,
  text: string,
): Promise<RatingComment> {
  const { data, error } = await ctx.supabase.rpc("update_rating_comment", {
    p_comment_id: commentId,
    p_comment_text: text,
  });

  if (error) {
    console.error("[RatingComments] update_rating_comment falhou:", error);
    if (error.message === COMMENT_UNAVAILABLE_MESSAGE) {
      throw new CommentNotAvailableError();
    }
    throw new Error("[RatingComments] Falha ao editar comentário.");
  }

  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  const comment = row ? toComment(ctx.supabase, row) : null;
  if (!comment) {
    throw new CommentNotAvailableError();
  }
  return comment;
}

/**
 * Apaga um comentário (autor OU dono da rating). Retorna o contador
 * restante da thread (fonte final — nunca negativo).
 */
export async function deleteRatingComment(
  ctx: RatingCommentsContext,
  commentId: number,
): Promise<{ removed: boolean; commentCount: number }> {
  const { data, error } = await ctx.supabase.rpc("delete_rating_comment", {
    p_comment_id: commentId,
  });

  if (error) {
    console.error("[RatingComments] delete_rating_comment falhou:", error);
    if (error.message === COMMENT_UNAVAILABLE_MESSAGE) {
      throw new CommentNotAvailableError();
    }
    throw new Error("[RatingComments] Falha ao apagar comentário.");
  }

  const row = (Array.isArray(data) ? data[0] : null) as {
    removed?: unknown;
    comment_count?: unknown;
  } | null;
  if (row?.removed !== true) {
    throw new CommentNotAvailableError();
  }
  return { removed: true, commentCount: toCount(row.comment_count) };
}

/**
 * States públicos em lote (até 24 targets). Só ratings visíveis
 * retornam; ausente = escondida/inexistente (sem oracle).
 * Falha/ausência da RPC (pré-migration) → [] (degrada sem quebrar).
 */
export async function getRatingCommentStates(
  supabase: SupabaseClient,
  targets: RatingCommentTarget[],
): Promise<RatingCommentState[]> {
  const limited = targets.slice(0, RATING_COMMENT_BATCH_SIZE);
  if (limited.length === 0) return [];

  const { data, error } = await supabase.rpc(
    "get_public_rating_comment_states",
    {
      p_targets: limited.map((t) => ({
        username: t.username,
        tmdb_id: t.tmdbId,
        media_type: t.mediaType,
      })),
    },
  );

  if (error || !Array.isArray(data)) {
    return [];
  }

  const states: RatingCommentState[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    if (!row || typeof row !== "object") continue;
    const { username, tmdb_id, media_type, comment_count, comments_enabled } = row;
    if (typeof username !== "string" || username.length === 0) continue;
    const tmdbId = Number(tmdb_id);
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) continue;
    if (media_type !== "movie" && media_type !== "tv") continue;
    states.push({
      username,
      tmdbId,
      mediaType: media_type as ContentType,
      commentCount: toCount(comment_count),
      commentsEnabled: comments_enabled === true,
    });
  }
  return states;
}

/** Atalho: sessão atual ou `null` (chamador decide 401/redirect). */
export async function getRatingCommentsSession(
  request: Request,
  cookies: AstroCookies,
): Promise<RatingCommentsContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}

/** Atalho p/ leitura: client SSR (auth.uid flui p/ a RPC) + viewer ou null. */
export async function getRatingCommentsViewer(
  request: Request,
  cookies: AstroCookies,
): Promise<RatingCommentsViewer> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  return { supabase, user };
}

export { RATING_COMMENT_DEFAULT_LIMIT };
