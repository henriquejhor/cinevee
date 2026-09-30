/**
 * Camada server-side de profile (RLS como enforcement).
 *
 * Regras:
 * - SOMENTE server (frontmatter / rotas API). Nunca importar no browser.
 * - O usuário-alvo sempre vem da sessão autenticada (`auth.getUser()`).
 *   O browser NUNCA envia user_id — não há parâmetro para isso.
 * - O Supabase client server-side age com o JWT do usuário, então as
 *   políticas RLS (`auth.uid() = id`) valem em cada query.
 * - Avatar: bucket `avatars`, path `{user_id}/{uuid}.{ext}`. O banco guarda
 *   SOMENTE o caminho (`avatar_path`); a URL pública é derivada na leitura.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getCurrentUser } from "../supabase/server";
import {
  EMPTY_PREFERENCES,
  EMPTY_PRIVACY,
  type PrivacySettings,
  type UserProfile,
} from "./types";
import type {
  ValidIdentityInput,
  ValidPreferencesInput,
  ValidPrivacyInput,
} from "./validation";
import { UsernameRequiredError } from "./validation";
import {
  AVATAR_ERROR_MESSAGE,
  AvatarValidationError,
  type ValidAvatarUpload,
} from "./validation";

/** Shape raw da tabela public.profiles (interno a este módulo). */
interface ProfileRow {
  id: string;
  display_name: string | null;
  username: string | null;
  bio: string | null;
  avatar_path: string | null;
  excluded_genres: string[] | null;
  streaming_providers: string[] | null;
  profile_public?: boolean | null;
  show_favorites?: boolean | null;
  show_recommendations?: boolean | null;
  show_watched?: boolean | null;
  show_ratings?: boolean | null;
  show_reviews?: boolean | null;
  discoverable?: boolean | null;
  show_activity?: boolean | null;
  allow_rating_comments?: boolean | null;
}

const PROFILE_COLUMNS =
  "id, display_name, username, bio, avatar_path, excluded_genres, streaming_providers, " +
  "profile_public, show_favorites, show_recommendations, show_watched, show_ratings, show_reviews, " +
  "discoverable, show_activity, allow_rating_comments";

/** Colunas pré-Etapa 19 (tudo da Etapa 17/18, só sem allow_rating_comments). */
const NO_COMMENTS_COLUMNS =
  "id, display_name, username, bio, avatar_path, excluded_genres, streaming_providers, " +
  "profile_public, show_favorites, show_recommendations, show_watched, show_ratings, show_reviews, " +
  "discoverable, show_activity";

/** Colunas pré-Etapa 17 (tudo da Etapa 15/16, só sem show_activity). */
const NO_ACTIVITY_COLUMNS =
  "id, display_name, username, bio, avatar_path, excluded_genres, streaming_providers, " +
  "profile_public, show_favorites, show_recommendations, show_watched, show_ratings, show_reviews, " +
  "discoverable";

/** Colunas pré-Etapa 15 (tudo da Etapa 14, só sem discoverable). */
const NO_DISCOVERABLE_COLUMNS =
  "id, display_name, username, bio, avatar_path, excluded_genres, streaming_providers, " +
  "profile_public, show_favorites, show_recommendations, show_watched, show_ratings, show_reviews";

/** Colunas pré-Etapa 14 (sem privacidade; fallback com defaults privados). */
const NO_PRIVACY_COLUMNS =
  "id, display_name, username, bio, avatar_path, excluded_genres, streaming_providers";

/** Colunas pré-Etapa 5 (fallback enquanto a migration nova não foi aplicada). */
const LEGACY_PROFILE_COLUMNS = "id, display_name, excluded_genres, streaming_providers";

const AVATAR_BUCKET = "avatars";

/** Username já em uso por outro usuário → 409 amigável. */
export class UsernameTakenError extends Error {
  constructor() {
    super("Esse nome de usuário já está em uso.");
    this.name = "UsernameTakenError";
  }
}

function avatarPublicUrl(
  supabase: SupabaseClient,
  avatarPath: string | null,
): string | null {
  if (!avatarPath) return null;
  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(avatarPath);
  return data?.publicUrl ?? null;
}

function toUserProfile(row: ProfileRow, supabase: SupabaseClient): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    username: row.username ?? null,
    bio: row.bio ?? null,
    avatarPath: row.avatar_path ?? null,
    avatarUrl: avatarPublicUrl(supabase, row.avatar_path ?? null),
    preferences: {
      excludedGenres: (Array.isArray(row.excluded_genres)
        ? row.excluded_genres
        : []) as UserProfile["preferences"]["excludedGenres"],
      streamingProviders: (Array.isArray(row.streaming_providers)
        ? row.streaming_providers
        : []) as UserProfile["preferences"]["streamingProviders"],
    },
    privacy: {
      profilePublic: row.profile_public === true,
      showFavorites: row.show_favorites === true,
      showRecommendations: row.show_recommendations === true,
      showWatched: row.show_watched === true,
      showRatings: row.show_ratings === true,
      // Opiniões sem avaliações nunca valem (defesa em profundidade —
      // a RPC pública também impõe isso no SQL).
      showReviews: row.show_reviews === true && row.show_ratings === true,
      discoverable: row.discoverable === true,
      showActivity: row.show_activity === true,
      allowRatingComments: row.allow_rating_comments === true,
    },
  };
}

/**
 * Lê a linha do profile com tolerância à migration pendente: tenta as
 * colunas da Etapa 5 e, se ainda não existirem, volta às colunas legadas
 * (username/bio/avatar → null). Pré-migration, nome e preferências
 * continuam funcionando como na Etapa 2/4.
 */
async function fetchProfileRow(
  supabase: SupabaseClient,
  userId: string,
  columns = PROFILE_COLUMNS,
): Promise<{ row: ProfileRow | null; migrated: boolean }> {
  const { data, error } = await supabase
    .from("profiles")
    .select(columns)
    .eq("id", userId)
    .maybeSingle();

  if (!error) {
    return { row: (data ?? null) as ProfileRow | null, migrated: columns === PROFILE_COLUMNS };
  }
  if (columns === PROFILE_COLUMNS) {
    // Pré-Etapa 19: tudo da Etapa 17/18, só sem allow_rating_comments
    // (migrated segue true: o resto funciona como antes, comentários
    // novos em default desligado).
    const noComments = await supabase
      .from("profiles")
      .select(NO_COMMENTS_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (!noComments.error) {
      return { row: (noComments.data ?? null) as ProfileRow | null, migrated: true };
    }
    // Pré-Etapa 17: tudo da Etapa 15/16, só sem show_activity (migrated
    // segue true: o resto funciona como antes, atividade em default).
    const noActivity = await supabase
      .from("profiles")
      .select(NO_ACTIVITY_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (!noActivity.error) {
      return { row: (noActivity.data ?? null) as ProfileRow | null, migrated: true };
    }
    // Pré-Etapa 15: tudo da Etapa 14, só sem discoverable (migrated segue
    // true: identidade/avatar/preferências funcionam como antes).
    const noDisc = await supabase
      .from("profiles")
      .select(NO_DISCOVERABLE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (!noDisc.error) {
      return { row: (noDisc.data ?? null) as ProfileRow | null, migrated: true };
    }
    // Pré-Etapa 14: mesmas colunas da Etapa 5, privacidade em defaults.
    const noPrivacy = await supabase
      .from("profiles")
      .select(NO_PRIVACY_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (!noPrivacy.error) {
      return { row: (noPrivacy.data ?? null) as ProfileRow | null, migrated: false };
    }
    const legacy = await supabase
      .from("profiles")
      .select(LEGACY_PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (!legacy.error) {
      return {
        row: { username: null, bio: null, avatar_path: null, ...(legacy.data ?? null) } as ProfileRow | null,
        migrated: false,
      };
    }
  }
  return { row: null, migrated: false };
}

export interface ProfileContext {
  supabase: SupabaseClient;
  user: User;
}

/**
 * Lê o profile da sessão atual.
 * Retorna `profile: null` quando a linha ainda não existe (ex.: backfill
 * pendente) ou a tabela está indisponível — o chamador usa fallback
 * (metadata/e-mail) em vez de quebrar a página. Pré-migration da Etapa 5,
 * lê as colunas legadas (username/bio/avatar → null).
 */
export async function getUserProfile(
  request: Request,
  cookies: AstroCookies,
): Promise<{ supabase: SupabaseClient; user: User | null; profile: UserProfile | null }> {
  const { supabase, user } = await getCurrentUser(request, cookies);

  if (!user) {
    return { supabase, user: null, profile: null };
  }

  try {
    const { row } = await fetchProfileRow(supabase, user.id);
    if (!row) {
      return { supabase, user, profile: null };
    }

    return { supabase, user, profile: toUserProfile(row, supabase) };
  } catch {
    return { supabase, user, profile: null };
  }
}

/**
 * Atualiza display_name + preferências do usuário DA SESSÃO.
 * Usa upsert pela própria id (resiliente caso o trigger ainda não tenha
 * criado a linha); RLS garante que só a linha `auth.uid() = id` é afetada.
 * Funciona pré-migration (colunas legadas) e pós-migration.
 */
export async function updateUserPreferences(
  ctx: ProfileContext,
  input: ValidPreferencesInput,
): Promise<UserProfile> {
  const { error } = await ctx.supabase.from("profiles").upsert(
    {
      id: ctx.user.id,
      display_name: input.displayName,
      excluded_genres: input.excludedGenres,
      streaming_providers: input.streamingProviders,
    },
    { onConflict: "id" },
  );

  if (error) {
    throw new Error("[Profile] Falha ao salvar preferências.");
  }

  const { row } = await fetchProfileRow(ctx.supabase, ctx.user.id);
  if (!row) {
    throw new Error("[Profile] Falha ao salvar preferências.");
  }

  return toUserProfile(row, ctx.supabase);
}

/**
 * Atualiza a identidade do usuário DA SESSÃO (nome + username + bio).
 * username/bio vazios viram NULL. Conflito de username → UsernameTakenError.
 * Exige a migration da Etapa 5 (colunas novas); sem ela, falha genérica
 * (a UI informa "Não foi possível salvar seu perfil.").
 */
export async function updateUserIdentity(
  ctx: ProfileContext,
  input: ValidIdentityInput,
): Promise<UserProfile> {
  const { error } = await ctx.supabase
    .from("profiles")
    .update({
      display_name: input.displayName,
      username: input.username,
      bio: input.bio,
    })
    .eq("id", ctx.user.id);

  if (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new UsernameTakenError();
    }
    throw new Error("[Profile] Falha ao salvar perfil.");
  }

  const { row, migrated } = await fetchProfileRow(ctx.supabase, ctx.user.id);
  if (!row || !migrated) {
    throw new Error("[Profile] Falha ao salvar perfil.");
  }

  return toUserProfile(row, ctx.supabase);
}

/**
 * Confere os magic bytes do arquivo contra o MIME declarado.
 * Um `.txt` renomeado para `.jpg` chega com MIME de imagem no FormData —
 * só os bytes revelam a fraude. Leve, sem dependências.
 */
async function assertAvatarContentMatchesMime(upload: ValidAvatarUpload): Promise<void> {
  let header: Uint8Array;
  try {
    header = new Uint8Array(await upload.file.slice(0, 12).arrayBuffer());
  } catch {
    throw new AvatarValidationError(AVATAR_ERROR_MESSAGE);
  }
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng =
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47;
  const riff =
    String.fromCharCode(header[0], header[1], header[2], header[3]) === "RIFF";
  const webp =
    String.fromCharCode(header[8], header[9], header[10], header[11]) === "WEBP";
  const matches =
    upload.mime === "image/jpeg"
      ? isJpeg
      : upload.mime === "image/png"
        ? isPng
        : riff && webp;
  if (!matches) {
    throw new AvatarValidationError(AVATAR_ERROR_MESSAGE);
  }
}

/**
 * Upload do avatar: valida conteúdo, salva o novo arquivo em path versionado
 * (`{user_id}/{uuid}.{ext}`), atualiza `avatar_path` e remove o anterior.
 * O antigo só é removido DEPOIS do novo confirmado — nunca o inverso.
 */
export async function uploadUserAvatar(
  ctx: ProfileContext,
  upload: ValidAvatarUpload,
): Promise<UserProfile> {
  await assertAvatarContentMatchesMime(upload);

  const newPath = `${ctx.user.id}/${crypto.randomUUID()}.${upload.extension}`;

  const { error: uploadError } = await ctx.supabase.storage
    .from(AVATAR_BUCKET)
    .upload(newPath, upload.file, {
      contentType: upload.mime,
      upsert: false,
    });

  if (uploadError) {
    throw new Error("[Profile] Falha ao enviar avatar.");
  }

  const { data: previous } = await ctx.supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", ctx.user.id)
    .maybeSingle();

  const { error } = await ctx.supabase
    .from("profiles")
    .update({ avatar_path: newPath })
    .eq("id", ctx.user.id);

  if (error) {
    // Novo arquivo órfão: tenta limpar para não deixar lixo no bucket.
    await ctx.supabase.storage.from(AVATAR_BUCKET).remove([newPath]);
    throw new Error("[Profile] Falha ao salvar avatar.");
  }

  const { row, migrated } = await fetchProfileRow(ctx.supabase, ctx.user.id);
  if (!row || !migrated) {
    await ctx.supabase.storage.from(AVATAR_BUCKET).remove([newPath]);
    throw new Error("[Profile] Falha ao salvar avatar.");
  }

  const oldPath = (previous as { avatar_path?: string | null } | null)?.avatar_path;
  if (oldPath && oldPath !== newPath) {
    await ctx.supabase.storage.from(AVATAR_BUCKET).remove([oldPath]);
  }

  return toUserProfile(row, ctx.supabase);
}

/**
 * Remove o avatar: exclui o arquivo do Storage e volta `avatar_path` a NULL
 * (UI retorna ao fallback de iniciais).
 */
export async function removeUserAvatar(ctx: ProfileContext): Promise<UserProfile> {
  const { data: current } = await ctx.supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", ctx.user.id)
    .maybeSingle();

  const oldPath = (current as { avatar_path?: string | null } | null)?.avatar_path;

  if (oldPath) {
    await ctx.supabase.storage.from(AVATAR_BUCKET).remove([oldPath]);
  }

  const { error } = await ctx.supabase
    .from("profiles")
    .update({ avatar_path: null })
    .eq("id", ctx.user.id);

  if (error) {
    throw new Error("[Profile] Falha ao remover avatar.");
  }

  const { row } = await fetchProfileRow(ctx.supabase, ctx.user.id);
  if (!row) {
    throw new Error("[Profile] Falha ao remover avatar.");
  }

  return toUserProfile(row, ctx.supabase);
}

/**
 * Lê as configurações de privacidade do usuário DA SESSÃO.
 * Pré-migration da Etapa 14: tudo desligado (privacidade conservadora).
 */
export async function getPrivacySettings(
  ctx: ProfileContext,
): Promise<PrivacySettings> {
  const { row } = await fetchProfileRow(ctx.supabase, ctx.user.id);
  if (!row) {
    return { ...EMPTY_PRIVACY };
  }
  return {
    profilePublic: row.profile_public === true,
    showFavorites: row.show_favorites === true,
    showRecommendations: row.show_recommendations === true,
    showWatched: row.show_watched === true,
    showRatings: row.show_ratings === true,
    showReviews: row.show_reviews === true && row.show_ratings === true,
    discoverable: row.discoverable === true,
    showActivity: row.show_activity === true,
    allowRatingComments: row.allow_rating_comments === true,
  };
}

/**
 * Atualiza a privacidade do usuário DA SESSÃO (só os 9 campos conhecidos).
 * Publicar — ou permitir descoberta na busca — exige username válido
 * (→ UsernameRequiredError amigável, com mensagem por caso).
 * showReviews sem showRatings normaliza para false (na validação).
 * discoverable/showActivity sem profilePublic são preservados (voltam a
 * valer se republicar).
 * Exige a migration da Etapa 15; sem ela, falha genérica.
 */
export async function updatePrivacySettings(
  ctx: ProfileContext,
  input: ValidPrivacyInput,
): Promise<PrivacySettings> {
  if (input.profilePublic || input.discoverable) {
    const { data, error: readError } = await ctx.supabase
      .from("profiles")
      .select("username")
      .eq("id", ctx.user.id)
      .maybeSingle();
    if (readError) {
      throw new Error("[Profile] Falha ao salvar privacidade.");
    }
    const username = (data as { username?: string | null } | null)?.username;
    if (!username) {
      throw new UsernameRequiredError(
        input.profilePublic
          ? "Crie um @username antes de publicar seu perfil."
          : "Crie um @username antes de permitir que seu perfil apareça na busca.",
      );
    }
  }

  const payload: Record<string, boolean> = {
    profile_public: input.profilePublic,
    show_favorites: input.showFavorites,
    show_recommendations: input.showRecommendations,
    show_watched: input.showWatched,
    show_ratings: input.showRatings,
    show_reviews: input.showReviews,
    discoverable: input.discoverable,
    show_activity: input.showActivity,
    allow_rating_comments: input.allowRatingComments,
  };

  let { error } = await ctx.supabase
    .from("profiles")
    .update(payload)
    .eq("id", ctx.user.id);

  // Pré-Etapa 19/17/15: coluna nova ainda não existe — regrava sem ela(s).
  // Só esse erro específico (PostgREST PGRST204: coluna ausente no schema
  // cache) recebe retry; qualquer outro falha genérico como antes.
  // Remove SOMENTE as colunas citadas na mensagem (até 3 tentativas),
  // para não descartar silenciosamente um toggle válido em DB parcial.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!error || (error as { code?: string }).code !== "PGRST204") break;
    const message = error.message ?? "";
    const dropComments =
      /allow_rating_comments/i.test(message) && "allow_rating_comments" in payload;
    const dropDiscoverable =
      /discoverable/i.test(message) && "discoverable" in payload;
    const dropActivity =
      /show_activity/i.test(message) && "show_activity" in payload;
    if (!dropComments && !dropDiscoverable && !dropActivity) break;
    if (dropComments) delete payload.allow_rating_comments;
    if (dropDiscoverable) delete payload.discoverable;
    if (dropActivity) delete payload.show_activity;
    ({ error } = await ctx.supabase
      .from("profiles")
      .update(payload)
      .eq("id", ctx.user.id));
  }

  if (error) {
    throw new Error("[Profile] Falha ao salvar privacidade.");
  }

  return getPrivacySettings(ctx);
}

export { EMPTY_PREFERENCES };
