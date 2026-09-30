/**
 * /api/profile/avatar — upload e remoção do avatar (Supabase Storage).
 *
 * POST — multipart { avatar: File }: valida tipo (JPEG/PNG/WebP) + tamanho
 *   (≤3 MB) + magic bytes server-side, salva em `{user_id}/{uuid}.{ext}`,
 *   atualiza `avatar_path` e remove o anterior. 200 { ok, profile }.
 * DELETE — remove o arquivo e volta `avatar_path` a NULL. 200 { ok, profile }.
 *
 * Deslogado → 401. Arquivo inválido → 400 amigável. Erro interno → 500
 * genérico (sem bucket internals, SQL, tokens ou stack traces).
 */
import type { APIRoute } from "astro";
import { getCurrentUser } from "../../../lib/supabase/server";
import { removeUserAvatar, uploadUserAvatar } from "../../../lib/profile/service";
import {
  AVATAR_ERROR_MESSAGE,
  AvatarValidationError,
  validateAvatarUpload,
} from "../../../lib/profile/validation";

export const prerender = false;

const UNAUTHORIZED = "Você precisa estar logado para alterar sua foto.";
const SAVE_ERROR = "Não foi possível salvar sua foto.";
const REMOVE_ERROR = "Não foi possível remover sua foto.";

export const POST: APIRoute = async ({ request, cookies }) => {
  const { supabase, user } = await getCurrentUser(request, cookies);

  if (!user) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: AVATAR_ERROR_MESSAGE }, { status: 400 });
  }

  try {
    const input = validateAvatarUpload(form.get("avatar"));
    const profile = await uploadUserAvatar({ supabase, user }, input);
    return Response.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof AvatarValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("[Profile] Falha ao enviar avatar.");
    return Response.json({ error: SAVE_ERROR }, { status: 500 });
  }
};

export const DELETE: APIRoute = async ({ request, cookies }) => {
  const { supabase, user } = await getCurrentUser(request, cookies);

  if (!user) {
    return Response.json({ error: UNAUTHORIZED }, { status: 401 });
  }

  try {
    const profile = await removeUserAvatar({ supabase, user });
    return Response.json({ ok: true, profile });
  } catch {
    console.error("[Profile] Falha ao remover avatar.");
    return Response.json({ error: REMOVE_ERROR }, { status: 500 });
  }
};
