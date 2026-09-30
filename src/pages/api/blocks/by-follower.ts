/**
 * POST /api/blocks/by-follower — bloqueia follower pela follow row.
 *
 * Body: { followId }. Resolve o follower server-side (só row própria).
 * 200 { blocked: true } · 404 genérico · 401. Sem UUID no I/O.
 */
import type { APIRoute } from "astro";
import {
  blockFollower,
  BlockNotAvailableError,
  getBlocksSession,
  SelfBlockError,
} from "../../../lib/blocks/service";
import { BlockValidationError } from "../../../lib/blocks/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado.";
const BLOCK_ERROR = "Não foi possível bloquear este usuário.";

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
    const result = await blockFollower(ctx, (body as Record<string, unknown>)?.followId);
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
    console.error("[Blocks] Falha ao bloquear seguidor.");
    return Response.json({ error: BLOCK_ERROR }, { status: 500 });
  }
};
