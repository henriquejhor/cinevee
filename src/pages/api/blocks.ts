/**
 * /api/blocks — bloqueio por username + desbloqueio + lista privada.
 *
 * POST { username } → 200 { blocked: true } · 409 self · 404 genérico · 401.
 * DELETE { blockId } → 200 { unblocked } · 404 · 401.
 * GET ?page=&limit= → 200 { items, page, pageSize, hasMore } · 401/400.
 * Erros genéricos (sem revelar block recebido); sem UUID no I/O.
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../lib/http/cache";
import {
  blockUser,
  BlockMissingError,
  BlockNotAvailableError,
  getBlocksSession,
  getMyBlockedUsersPage,
  SelfBlockError,
  unblockUser,
} from "../../lib/blocks/service";
import {
  BLOCKS_PAGE_SIZE,
  type BlockedUsersPage,
} from "../../lib/blocks/types";
import {
  BlockValidationError,
  validateBlocksPage,
} from "../../lib/blocks/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado.";
const LIST_ERROR = "Não foi possível carregar seus bloqueios agora.";
const BLOCK_ERROR = "Não foi possível bloquear este usuário.";
const UNBLOCK_ERROR = "Não foi possível desbloquear este usuário.";

export const GET: APIRoute = async ({ request, cookies, url }) => {
  const ctx = await getBlocksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }
  const parsed = validateBlocksPage(
    url.searchParams.get("page") ?? "1",
    url.searchParams.get("limit"),
    BLOCKS_PAGE_SIZE,
  );
  if (!parsed) {
    return Response.json({ error: "Página inválida." }, { status: 400 });
  }
  try {
    const result: BlockedUsersPage = await getMyBlockedUsersPage(ctx, parsed.page, parsed.limit);
    return privateJson(result);
  } catch {
    console.error("[Blocks] Falha ao listar bloqueados.");
    return Response.json({ error: LIST_ERROR }, { status: 502 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getBlocksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Usuário indisponível." }, { status: 404 });
  }
  try {
    const result = await blockUser(ctx, (body as Record<string, unknown>)?.username);
    return Response.json(result);
  } catch (error) {
    if (error instanceof BlockValidationError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof SelfBlockError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof BlockNotAvailableError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Blocks] Falha ao bloquear.");
    return Response.json({ error: BLOCK_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getBlocksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Item indisponível." }, { status: 404 });
  }
  try {
    const result = await unblockUser(ctx, (body as Record<string, unknown>)?.blockId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof BlockValidationError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof BlockMissingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Blocks] Falha ao desbloquear.");
    return Response.json({ error: UNBLOCK_ERROR }, { status: 500 });
  }
};
