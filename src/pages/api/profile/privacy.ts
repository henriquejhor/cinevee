/**
 * /api/profile/privacy — privacidade do perfil público (Etapa 14).
 *
 * - Usuário-alvo derivado da SESSÃO. O body nunca contém user_id.
 * - GET → 200 { privacy } (tudo false pré-migration/privado).
 * - PATCH → 200 { ok: true, privacy }. Aceita SOMENTE os 9 campos
 *   conhecidos; qualquer outro campo é ignorado (nunca persistido).
 * - Publicar/descobrir sem username → 400 "Crie um @username antes...".
 * - Payload inválido → 400. Deslogado → 401. Erro interno → 500 genérico.
 */
import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/supabase/server";
import {
  getPrivacySettings,
  updatePrivacySettings,
} from "../../../lib/profile/service";
import {
  PrivacyValidationError,
  UsernameRequiredError,
  validatePrivacyPayload,
} from "../../../lib/profile/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para editar seu perfil.";
const LOAD_ERROR = "Não foi possível carregar sua privacidade.";
const SAVE_ERROR = "Não foi possível salvar sua privacidade.";

export const GET: APIRoute = async ({ request, cookies }) => {
  const { supabase, user } = await getCurrentUser(request, cookies);

  if (!user) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const privacy = await getPrivacySettings({ supabase, user });
    return Response.json({ privacy });
  } catch {
    console.error("[Profile] Falha ao carregar privacidade.");
    return Response.json({ error: LOAD_ERROR }, { status: 500 });
  }
};

export const PATCH: APIRoute = async ({ request, cookies }) => {
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
    const input = validatePrivacyPayload(body);
    const privacy = await updatePrivacySettings({ supabase, user }, input);
    return Response.json({ ok: true, privacy });
  } catch (error) {
    if (error instanceof PrivacyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UsernameRequiredError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Profile] Falha ao salvar privacidade.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};
