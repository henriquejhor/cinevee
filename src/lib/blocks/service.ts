/**
 * Camada server-side de bloqueio + gestão de seguidores (Etapa 23).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário é sempre auth.uid() interno das RPCs. O browser NUNCA
 *   envia blocker_id/blocked_id/follower_id — só username (resolvido
 *   server-side) ou ids bigint opacos (blockId/followId).
 * - Sem `.from("user_blocks")` nem `.from("follows")`: tudo via RPCs
 *   (RLS sem policies bloqueia o direto).
 * - Erros genéricos ("Usuário indisponível.") para não revelar block
 *   recebido; self-block tem erro próprio (→ 409).
 * - Erro real vai para o log server-side (nunca para o browser).
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { AstroCookies } from "astro";
import { getCurrentUser } from "../supabase/server";
import {
  BLOCKS_PAGE_SIZE,
  type BlockedUserItem,
  type BlockedUsersPage,
  type FollowerItem,
  type FollowersPage,
} from "./types";
import {
  BlockValidationError,
  validateBlockId,
  validateBlocksPage,
  validateBlockUsername,
  validateFollowId,
} from "./validation";

export interface BlocksContext {
  supabase: SupabaseClient;
  user: User;
}

/** Alvo inválido/inexistente (genérico — sem oracle de block). */
export class BlockNotAvailableError extends Error {
  constructor(message = "Usuário indisponível.") {
    super(message);
    this.name = "BlockNotAvailableError";
  }
}

/** Bloquear a si mesmo → 409. */
export class SelfBlockError extends Error {
  constructor() {
    super("Você não pode bloquear a si mesmo.");
    this.name = "SelfBlockError";
  }
}

/** Item de gestão inexistente ou de outro usuário → 404. */
export class BlockMissingError extends Error {
  constructor(message = "Item indisponível.") {
    super(message);
    this.name = "BlockMissingError";
  }
}

const SELF_MESSAGE = "Você não pode bloquear a si mesmo.";

const AVATAR_BUCKET = "avatars";

function avatarPublicUrl(supabase: SupabaseClient, avatarPath: string | null): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

/** Sessão (401 quando deslogado). */
export async function getBlocksSession(
  request: Request,
  cookies: AstroCookies,
): Promise<BlocksContext | null> {
  const { supabase, user } = await getCurrentUser(request, cookies);
  if (!user) return null;
  return { supabase, user };
}

function toBlockedItem(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): BlockedUserItem | null {
  const blockId = row.block_id;
  const blockedAt = row.blocked_at;
  if (typeof blockId !== "number" || !Number.isSafeInteger(blockId) || blockId < 1) return null;
  if (typeof blockedAt !== "string") return null;
  return {
    blockId,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    username: typeof row.username === "string" ? row.username : null,
    avatarUrl: avatarPublicUrl(supabase, typeof row.avatar_path === "string" ? row.avatar_path : null),
    blockedAt,
  };
}

function toFollowerItem(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
): FollowerItem | null {
  const followId = row.follow_id;
  if (typeof followId !== "number" || !Number.isSafeInteger(followId) || followId < 1) return null;
  return {
    followId,
    displayName: typeof row.display_name === "string" ? row.display_name : null,
    username: typeof row.username === "string" ? row.username : null,
    avatarUrl: avatarPublicUrl(supabase, typeof row.avatar_path === "string" ? row.avatar_path : null),
    followedAt: typeof row.followed_at === "string" ? row.followed_at : null,
    isPublic: row.is_public === true,
  };
}

async function fetchPage<T>(
  supabase: SupabaseClient,
  rpc: string,
  page: number,
  limit: number,
  map: (supabase: SupabaseClient, row: Record<string, unknown>) => T | null,
  idOf: (item: T) => number,
): Promise<{ items: T[]; page: number; pageSize: number; hasMore: boolean }> {
  const offset = (page - 1) * limit;
  const { data, error } = await supabase.rpc(rpc, { p_limit: limit, p_offset: offset });
  if (error) {
    throw new Error(`[Blocks] Falha ao carregar (${rpc}).`);
  }
  const rows = Array.isArray(data) ? data : [];
  const items: T[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = map(supabase, row as Record<string, unknown>);
    if (!item || seen.has(idOf(item))) continue;
    seen.add(idOf(item));
    items.push(item);
  }

  let hasMore = false;
  const probe = await supabase.rpc(rpc, { p_limit: 1, p_offset: offset + limit });
  if (!probe.error && Array.isArray(probe.data)) {
    hasMore = probe.data.length > 0;
  }

  return { items, page, pageSize: limit, hasMore };
}

/** Bloqueia por username (idempotente; self → 409; inválido → 404). */
export async function blockUser(ctx: BlocksContext, username: unknown): Promise<{ blocked: boolean }> {
  const clean = validateBlockUsername(username);
  const { data, error } = await ctx.supabase.rpc("block_user_by_username", {
    p_username: clean,
  });
  if (error) {
    console.error("[Blocks] block_user_by_username falhou:", error);
    if (error.message === SELF_MESSAGE) throw new SelfBlockError();
    throw new BlockNotAvailableError();
  }
  return { blocked: data === true };
}

/** Bloqueia follower pela follow row própria (sem expor UUID). */
export async function blockFollower(ctx: BlocksContext, followId: unknown): Promise<{ blocked: boolean }> {
  const id = validateFollowId(followId);
  const { data, error } = await ctx.supabase.rpc("block_my_follower", {
    p_follow_id: id,
  });
  if (error) {
    console.error("[Blocks] block_my_follower falhou:", error);
    if (error.message === SELF_MESSAGE) throw new SelfBlockError();
    throw new BlockNotAvailableError();
  }
  return { blocked: data === true };
}

/** Desbloqueia pela block row própria. */
export async function unblockUser(ctx: BlocksContext, blockId: unknown): Promise<{ unblocked: boolean }> {
  const id = validateBlockId(blockId);
  const { data, error } = await ctx.supabase.rpc("unblock_user", {
    p_block_id: id,
  });
  if (error) {
    console.error("[Blocks] unblock_user falhou:", error);
    throw new BlockMissingError();
  }
  return { unblocked: data === true };
}

/** Lista privada de bloqueados (24 + probe). */
export async function getMyBlockedUsersPage(
  ctx: BlocksContext,
  page: number,
  limit: number = BLOCKS_PAGE_SIZE,
): Promise<BlockedUsersPage> {
  return fetchPage(ctx.supabase, "get_my_blocked_users", page, limit, toBlockedItem, (i) => i.blockId);
}

/** Lista privada de seguidores (24 + probe). */
export async function getMyFollowersPage(
  ctx: BlocksContext,
  page: number,
  limit: number = BLOCKS_PAGE_SIZE,
): Promise<FollowersPage> {
  return fetchPage(ctx.supabase, "get_my_followers", page, limit, toFollowerItem, (i) => i.followId);
}

/** Remove seguidor (sem block; idempotente por dono). */
export async function removeFollower(ctx: BlocksContext, followId: unknown): Promise<{ removed: boolean }> {
  const id = validateFollowId(followId);
  const { data, error } = await ctx.supabase.rpc("remove_my_follower", {
    p_follow_id: id,
  });
  if (error) {
    console.error("[Blocks] remove_my_follower falhou:", error);
    throw new BlockMissingError();
  }
  return { removed: data === true };
}

export { BLOCKS_PAGE_SIZE, BlockValidationError, validateBlocksPage };
