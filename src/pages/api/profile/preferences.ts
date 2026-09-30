/**
 * /api/profile/preferences
 *
 * GET — lê preferências para a UI do /descobrir (prerender preservado).
 *   Retorna SOMENTE { excludedGenres, streamingProviders } — sem id,
 *   e-mail, tokens ou dados extras. Deslogado → 401. O enforcement real
 *   continua server-side nos endpoints do Discovery.
 *
 * POST — salva nome + preferências do usuário.
 * - Usuário-alvo derivado da SESSÃO (getCurrentUser). O body nunca contém
 *   user_id — qualquer id enviado é ignorado.
 * - Payload inválido → 400. Deslogado → 401. Erro interno → 500 genérico
 *   (nunca vaza erro bruto do Supabase).
 * - Body JSON: { displayName, excludedGenres, streamingProviders }.
 */
import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/supabase/server";
import { getUserProfile, updateUserPreferences } from "../../../lib/profile/service";
import { EMPTY_PREFERENCES } from "../../../lib/profile/types";
import {
  PreferencesValidationError,
  validatePreferencesPayload,
} from "../../../lib/profile/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para salvar preferências.";
const SAVE_ERROR = "Não foi possível salvar suas preferências.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const { user, profile } = await getUserProfile(request, cookies);

  if (!user) {
    return Response.json({ error: "Não autenticado." }, { status: 401 });
  }

  const prefs = profile?.preferences ?? EMPTY_PREFERENCES;
  return Response.json({
    excludedGenres: prefs.excludedGenres,
    streamingProviders: prefs.streamingProviders,
  });
};

export const POST: APIRoute = async ({ request, cookies }) => {
  const { supabase, user } = await getCurrentUser(request, cookies);

  if (!user) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Dados inválidos." }, { status: 400 });
  }

  try {
    const input = validatePreferencesPayload(body);
    const profile = await updateUserPreferences({ supabase, user }, input);
    return Response.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof PreferencesValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Profile] Falha ao salvar preferências.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};
