/**
 * Camada server-side de respostas em comentários (Etapa 22, 1 nível).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - Mutações passam pelas RPCs create/update/delete_rating_comment_reply,
 *   que usam auth.uid() interno. O browser NUNCA envia author_id.
 * - Gates de criação = create de comentário (thread pública + allow).
 *   Self-reply → 409 próprio. Desativado → 403 próprio.
 * - Leitura em lote lazy por comentário (get_public_..._replies).
 * - Erro real vai para o log server-side (nunca para o browser).
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { getCurrentUser } from "../supabase/server";
import {
  REPLY_PAGE_SIZE,
  type CommentReplyItem,
  type CommentReplyPage,
} from "./types";
import {
  ReplyValidationError,
  validateCommentId,
  validateRepliesQuery,
  validateReplyId,
  validateReplyText,
} from "./validation";

export interface CommentReplyContext {
  supabase: SupabaseClient;
  user: User;
}

export interface CommentReplyViewer {
  supabase: SupabaseClient;
  user: User | null;
}

/** Sessão de escrita (401 quando deslogado). */
export async function getReplySession(
  request: Request,
  cookies: AstroCookies,
): Promise<CommentReplyContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}

/** Atalho p/ leitura: client SSR (auth.uid flui p/ a RPC) + viewer ou null. */
export async function getReplyViewer(
  request: Request,
  cookies: AstroCookies,
): Promise<CommentReplyViewer> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  return { supabase, user };
}

/** Thread indisponível (privada/inexistente/sem rating). */
export class ReplyNotAvailableError extends Error {
  constructor(message = "Comentário indisponível.") {
    super(message);
    this.name = "ReplyNotAvailableError";
  }
}

/** Thread com novos replies desativados → 403. */
export class RepliesDisabledError extends Error {
  constructor() {
    super("Novas respostas estão desativadas nesta avaliação.");
    this.name = "RepliesDisabledError";
  }
}

/** Responder o próprio comentário → 409. */
export class SelfReplyError extends Error {
  constructor() {
    super("Você não pode responder ao próprio comentário.");
    this.name = "SelfReplyError";
  }
}

/** Reply inexistente ou sem permissão → 404. */
export class ReplyMissingError extends Error {
  constructor(message = "Resposta indisponível.") {
    super(message);
    this.name = "ReplyMissingError";
  }
}

const AVATAR_BUCKET = "avatars";

function avatarPublicUrl(supabase: SupabaseClient, avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

const SELF_MESSAGE = "Você não pode responder ao próprio comentário.";
const DISABLED_MESSAGE = "Novas respostas estão desativadas nesta avaliação.";
const REPLY_UNAVAILABLE_MESSAGE = "Resposta indisponível.";

function toCount(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function isEdited(createdAt: string, updatedAt: string): boolean {
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return updated - created > 1000;
}

function toReplyItem(supabase: SupabaseClient, row: Record<string, unknown>): CommentReplyItem | null {
  const replyId = row.reply_id;
  const text = row.reply_text;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (typeof replyId !== "number" || !Number.isSafeInteger(replyId) || replyId < 1) return null;
  if (typeof text !== "string") return null;
  if (typeof createdAt !== "string" || typeof updatedAt !== "string") return null;
  const author = row as Record<string, unknown>;
  const isPrivate = author.author_is_private === true;
  return {
    replyId,
    text,
    createdAt,
    updatedAt,
    edited: isEdited(createdAt, updatedAt),
    author: {
      isPrivate,
      displayName:
        !isPrivate && typeof author.author_display_name === "string"
          ? author.author_display_name
          : null,
      username:
        !isPrivate && typeof author.author_username === "string" ? author.author_username : null,
      avatarUrl:
        !isPrivate && typeof author.author_avatar_path === "string"
          ? avatarPublicUrl(supabase, author.author_avatar_path)
          : null,
    },
    canEdit: row.can_edit === true,
    canDelete: row.can_delete === true,
  };
}

/**
 * Página de replies (limit + probe no próximo offset — sem limit+1
 * contra o clamp da RPC). Ordem cronológica (a RPC ordena).
 */
export async function getCommentRepliesPage(
  supabase: SupabaseClient,
  commentId: number,
  page: number,
  limit: number,
): Promise<CommentReplyPage> {
  const offset = (page - 1) * limit;
  const { data, error } = await supabase.rpc("get_public_rating_comment_replies", {
    p_comment_id: commentId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) {
    throw new Error("[Replies] Falha ao carregar respostas.");
  }
  const rows = Array.isArray(data) ? data : [];
  const items: CommentReplyItem[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = toReplyItem(supabase, row as Record<string, unknown>);
    if (!item || seen.has(item.replyId)) continue;
    seen.add(item.replyId);
    items.push(item);
  }

  let hasMore = false;
  const probe = await supabase.rpc("get_public_rating_comment_replies", {
    p_comment_id: commentId,
    p_limit: 1,
    p_offset: offset + limit,
  });
  if (!probe.error && Array.isArray(probe.data)) {
    hasMore = probe.data.length > 0;
  }

  return { items, page, pageSize: limit, hasMore };
}

export async function createCommentReply(
  ctx: CommentReplyContext,
  input: { commentId: unknown; text: unknown },
): Promise<{ reply: CommentReplyItem; replyCount: number }> {
  const commentId = validateCommentId(input.commentId);
  const text = validateReplyText(input.text);
  const { data, error } = await ctx.supabase.rpc("create_rating_comment_reply", {
    p_comment_id: commentId,
    p_text: text,
  });
  if (error) {
    console.error("[Replies] create_rating_comment_reply falhou:", error);
    if (error.message === SELF_MESSAGE) throw new SelfReplyError();
    if (error.message === DISABLED_MESSAGE) throw new RepliesDisabledError();
    throw new ReplyNotAvailableError();
  }
  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  const reply = row ? toReplyItem(ctx.supabase, row) : null;
  if (!reply) throw new Error("[Replies] Resposta inválida do servidor.");
  return { reply, replyCount: toCount(row?.reply_count) };
}

export async function updateCommentReply(
  ctx: CommentReplyContext,
  input: { replyId: unknown; text: unknown },
): Promise<CommentReplyItem> {
  const replyId = validateReplyId(input.replyId);
  const text = validateReplyText(input.text);
  const { data, error } = await ctx.supabase.rpc("update_rating_comment_reply", {
    p_reply_id: replyId,
    p_text: text,
  });
  if (error) {
    console.error("[Replies] update_rating_comment_reply falhou:", error);
    if (error.message === REPLY_UNAVAILABLE_MESSAGE) throw new ReplyMissingError();
    throw new ReplyMissingError();
  }
  const row = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
  const reply = row ? toReplyItem(ctx.supabase, row) : null;
  if (!reply) throw new Error("[Replies] Resposta inválida do servidor.");
  return reply;
}

export async function deleteCommentReply(
  ctx: CommentReplyContext,
  replyId: unknown,
): Promise<{ removed: boolean; replyCount: number }> {
  const id = validateReplyId(replyId);
  const { data, error } = await ctx.supabase.rpc("delete_rating_comment_reply", {
    p_reply_id: id,
  });
  if (error) {
    console.error("[Replies] delete_rating_comment_reply falhou:", error);
    throw new ReplyMissingError();
  }
  const row = (Array.isArray(data) ? data[0] : null) as {
    removed?: unknown;
    reply_count?: unknown;
  } | null;
  if (!row || row.removed !== true) throw new ReplyMissingError();
  return { removed: true, replyCount: toCount(row.reply_count) };
}

export { REPLY_PAGE_SIZE, ReplyValidationError, validateRepliesQuery };
