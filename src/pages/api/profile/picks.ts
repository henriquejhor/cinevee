/**
 * /api/profile/picks — Sobre: favoritos + recomendações (só o dono, via sessão).
 *
 * GET — { favorites, recommendations } ordenados por posição:
 *   200 { favorites, recommendations }.
 * POST — adiciona { tmdbId, mediaType, kind, note? }: valida sessão +
 *   input, confirma o título no TMDB server-side (snapshot factual),
 *   aplica limites (12/6) e unicidade por seção com erro amigável.
 *   200 { ok: true, item } · 404 título inexistente · 409 duplicata/limite ·
 *   400 input inválido · 502 TMDB fora.
 * PATCH — { op: "note", id, note } edita a justificativa (só
 *   recommendation, preserva posição) ou { op: "reorder", kind,
 *   orderedIds } persiste a ordem manual completa da seção.
 *   200 { ok: true, item } / { ok: true, items } · 404 pick inexistente.
 * DELETE — remove { id }: apaga só aquele kind (o mesmo título na outra
 *   seção continua). 200 { ok: true, removed }.
 *
 * O browser nunca envia user_id; title/poster/year do body são ignorados
 * (vêm do TMDB). Erros nunca vazam SQL, stack trace ou tokens.
 * Picks NÃO alimentam o TasteProfile. Nada aqui é público.
 */
import type { APIRoute } from "astro";
import {
  addProfilePick,
  DuplicatePickError,
  getFavorites,
  getProfilePicksSession,
  getRecommendations,
  PickLimitError,
  PickNotFoundError,
  removeProfilePick,
  reorderProfilePicks,
  TitleNotFoundError,
  updateRecommendationNote,
} from "../../../lib/profilePicks/service";
import {
  ProfilePicksValidationError,
  validateAddPickInput,
  validateRemovePickInput,
  validateReorderPicksInput,
  validateUpdatePickNoteInput,
} from "../../../lib/profilePicks/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para editar seu perfil.";
const LOAD_ERROR = "Não foi possível carregar suas seleções.";
const SAVE_ERROR = "Não foi possível salvar sua seleção.";
const NOTE_ERROR = "Não foi possível salvar sua recomendação.";
const REORDER_ERROR = "Não foi possível reordenar sua lista.";
const REMOVE_ERROR = "Não foi possível remover sua seleção.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const ctx = await getProfilePicksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const [favorites, recommendations] = await Promise.all([
      getFavorites(ctx),
      getRecommendations(ctx),
    ]);
    return Response.json({ favorites, recommendations });
  } catch {
    console.error("[ProfilePicks] Falha ao carregar seleções.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const ctx = await getProfilePicksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateAddPickInput(body);
    const item = await addProfilePick(ctx, input);
    return Response.json({ ok: true, item });
  } catch (error) {
    if (error instanceof ProfilePicksValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof DuplicatePickError || error instanceof PickLimitError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof TitleNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[ProfilePicks] Falha ao salvar seleção.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
  const ctx = await getProfilePicksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  const op = (body as Record<string, unknown> | null)?.op;

  try {
    if (op === "reorder") {
      const input = validateReorderPicksInput(body);
      const items = await reorderProfilePicks(ctx, input.kind, input.orderedIds);
      return Response.json({ ok: true, items });
    }
    const input = validateUpdatePickNoteInput(body);
    const item = await updateRecommendationNote(ctx, input.id, input.note);
    return Response.json({ ok: true, item });
  } catch (error) {
    if (error instanceof ProfilePicksValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof PickNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error("[ProfilePicks] Falha ao atualizar seleção.");
    return Response.json(
      { error: op === "reorder" ? REORDER_ERROR : NOTE_ERROR },
      { status: 500 },
    );
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const ctx = await getProfilePicksSession(request, cookies);
  if (!ctx) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validateRemovePickInput(body);
    const removed = await removeProfilePick(ctx, input.id);
    return Response.json({ ok: true, removed: removed !== null });
  } catch (error) {
    if (error instanceof ProfilePicksValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[ProfilePicks] Falha ao remover seleção.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
