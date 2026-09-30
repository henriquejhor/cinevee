/**
 * POST /api/followers/remove — remove seguidor sem bloquear.
 *
 * Body: { followId } (só row onde following = eu). Apaga também a
 * follow notification. 200 { removed } · 404 · 401. Refollow permitido.
 */
import type { APIRoute } from "astro";
import {
  BlockMissingError,
  getBlocksSession,
  removeFollower,
} from "../../../lib/blocks/service";
import { BlockValidationError } from "../../../lib/blocks/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado.";
const REMOVE_ERROR = "Não foi possível remover este seguidor.";

export const POST: APIRoute = async ({ request, cookies }) => {
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
    const result = await removeFollower(ctx, (body as Record<string, unknown>)?.followId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof BlockValidationError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof BlockMissingError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[Blocks] Falha ao remover seguidor.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
