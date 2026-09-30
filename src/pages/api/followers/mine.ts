/**
 * GET /api/followers/mine — seguidores próprios (management privada).
 *
 * Inclui followers private (relação direta). ?page=&limit= (24+probe).
 * 200 { items, page, pageSize, hasMore } · 401 · 400 · 502. Sem UUID.
 */
import type { APIRoute } from "astro";
import { privateJson } from "../../../lib/http/cache";
import {
  getBlocksSession,
  getMyFollowersPage,
} from "../../../lib/blocks/service";
import {
  BLOCKS_PAGE_SIZE,
  type FollowersPage,
} from "../../../lib/blocks/types";
import { validateBlocksPage } from "../../../lib/blocks/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado.";
const LIST_ERROR = "Não foi possível carregar seus seguidores agora.";

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
    const result: FollowersPage = await getMyFollowersPage(ctx, parsed.page, parsed.limit);
    return privateJson(result);
  } catch {
    console.error("[Blocks] Falha ao listar seguidores.");
    return Response.json({ error: LIST_ERROR }, { status: 502 });
  }
};
