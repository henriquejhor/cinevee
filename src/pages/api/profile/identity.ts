/**
 * PUT /api/profile/identity — identidade do usuário (nome + username + bio).
 *
 * - Usuário-alvo derivado da SESSÃO. O body nunca contém user_id.
 * - Body JSON: { displayName, username, bio } (username/bio opcionais).
 * - username em conflito → 409 "Esse nome de usuário já está em uso."
 * - Payload inválido → 400. Deslogado → 401. Erro interno → 500 genérico.
 */
import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/supabase/server";
import { updateUserIdentity, UsernameTakenError } from "../../../lib/profile/service";
import {
  IdentityValidationError,
  validateIdentityPayload,
} from "../../../lib/profile/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para editar seu perfil.";
const SAVE_ERROR = "Não foi possível salvar seu perfil.";

export const PUT: APIRoute = async ({ request, cookies }) => {
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
    const input = validateIdentityPayload(body);
    const profile = await updateUserIdentity({ supabase, user }, input);
    return Response.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof IdentityValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UsernameTakenError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    console.error("[Profile] Falha ao salvar identidade.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};
