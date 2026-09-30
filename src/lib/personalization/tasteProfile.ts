/**
 * Orquestração server-side de personalização (Etapa 8).
 *
 * - `buildPersonalization(request, cookies)`: chaves watched + TasteProfile
 *   + versão, com degradação graciosa (qualquer falha vira vazio + log
 *   seguro; nunca lança, nunca quebra recomendações).
 * - `getPersonalizationVersion(request, cookies)`: versão barata (só
 *   contagens + último updated_at) para invalidar o cache do client.
 * - Deslogado: vazio imediato, sem queries extras (latência inalterada).
 *
 * Enriquecimento TMDB: amostra de no máximo MAX_ENRICH_TITLES, em
 * paralelo, best-effort (falha isolada ignora só aquele título), com
 * cache in-memory curto por `mediaType:tmdbId` (sem Redis/banco).
 * Reutiliza `tmdbFetch` — nenhum client novo.
 */
import type { AstroCookies } from "astro";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ContentType } from "../../types/content";
import type { GenreKey } from "../../types/discovery";
import { getCurrentUser } from "../supabase/server";
import { perf, perfCount } from "../perf";
import { MOVIE_GENRE_IDS, TV_GENRE_IDS } from "../discovery/genres";
import { tmdbFetch } from "../tmdb/client";
import {
  ANON_TASTE_VERSION,
  buildTasteProfile,
  emptyTasteProfile,
  hashStringList,
  MAX_ENRICH_TITLES,
  ratingGenreWeight,
  tasteVersion,
  watchedKey,
  type EnrichedRating,
  type TasteProfile,
} from "./taste";

export interface Personalization {
  /** Chaves `mediaType:tmdbId` assistidos (hard exclusion). */
  watchedTitleKeys: string[];
  tasteProfile: TasteProfile;
  /** Versão opaca do histórico (cache do client). */
  version: string;
}

/** Amostra de ratings recentes (versionamento + seleção p/ enriquecer). */
const RATINGS_SAMPLE_LIMIT = 60;
/** Teto do cache in-memory de gêneros (FIFO simples). */
const GENRE_CACHE_LIMIT = 200;
/**
 * Cache in-memory do TasteProfile por usuário (server-side, processo).
 * Chave de validade: (ratedCount + updated_at[] da amostra) — qualquer
 * edição dentro da janela invalida. TTL curto + teto de entradas;
 * guarda SÓ o taste derivado (watchedKeys continuam lidas frescas).
 */
const TASTE_CACHE_TTL_MS = 5 * 60 * 1000;
const TASTE_CACHE_LIMIT = 100;

interface TasteCacheEntry {
  ratedCount: number;
  updatedAtHash: string;
  taste: TasteProfile;
  expiresAt: number;
}

const tasteCache = new Map<string, TasteCacheEntry>();

function tasteCacheGet(
  userId: string,
  ratedCount: number,
  updatedAtList: string[],
): TasteProfile | null {
  const entry = tasteCache.get(userId);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) tasteCache.delete(userId);
    return null;
  }
  if (entry.ratedCount !== ratedCount) return null;
  if (entry.updatedAtHash !== hashStringList(updatedAtList)) return null;
  return entry.taste;
}

function tasteCacheSet(
  userId: string,
  ratedCount: number,
  updatedAtList: string[],
  taste: TasteProfile,
): void {
  if (tasteCache.has(userId)) tasteCache.delete(userId);
  tasteCache.set(userId, {
    ratedCount,
    updatedAtHash: hashStringList(updatedAtList),
    taste,
    expiresAt: Date.now() + TASTE_CACHE_TTL_MS,
  });
  if (tasteCache.size > TASTE_CACHE_LIMIT) {
    const oldest = tasteCache.keys().next();
    if (!oldest.done) tasteCache.delete(oldest.value);
  }
}

interface GenreCacheEntry {
  title: string;
  year?: number;
  genres: GenreKey[];
}

const genreCache = new Map<string, GenreCacheEntry>();

/** Mapa reverso TMDB id → GenreKeys, por tipo (construído uma vez). */
let reverseGenreMap: Map<string, GenreKey[]> | null = null;

function getReverseGenreMap(): Map<string, GenreKey[]> {
  if (reverseGenreMap) return reverseGenreMap;
  const map = new Map<string, GenreKey[]>();
  const tables: { type: ContentType; ids: Record<string, number[]> }[] = [
    { type: "movie", ids: MOVIE_GENRE_IDS as Record<string, number[]> },
    { type: "tv", ids: TV_GENRE_IDS as Record<string, number[]> },
  ];
  for (const { type, ids } of tables) {
    for (const [genre, tmdbIds] of Object.entries(ids)) {
      for (const id of tmdbIds) {
        const key = `${type}:${id}`;
        const list = map.get(key) ?? [];
        if (!list.includes(genre as GenreKey)) list.push(genre as GenreKey);
        map.set(key, list);
      }
    }
  }
  reverseGenreMap = map;
  return map;
}

function cacheGet(key: string): GenreCacheEntry | null {
  return genreCache.get(key) ?? null;
}

function cacheSet(key: string, entry: GenreCacheEntry): void {
  if (genreCache.has(key)) genreCache.delete(key);
  genreCache.set(key, entry);
  if (genreCache.size > GENRE_CACHE_LIMIT) {
    const oldest = genreCache.keys().next();
    if (!oldest.done) genreCache.delete(oldest.value);
  }
}

interface RatingSampleRow {
  tmdb_id: number;
  media_type: string;
  rating: number;
  updated_at: string;
}

interface TmdbDetailsGenres {
  genres?: { id: number; name?: string }[];
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
}

function extractYear(date?: string): number | undefined {
  if (!date || date.length < 4) return undefined;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isNaN(year) ? undefined : year;
}

/**
 * Enriquece UM rating com título/ano/gêneros reais do TMDB.
 * Falha isolada → null (o título é ignorado, o resto continua).
 */
async function enrichRating(row: RatingSampleRow): Promise<EnrichedRating | null> {
  if (row.media_type !== "movie" && row.media_type !== "tv") return null;
  const mediaType = row.media_type as ContentType;
  const key = watchedKey(mediaType, Number(row.tmdb_id));
  const cached = cacheGet(key);
  if (cached) {
    return {
      tmdbId: Number(row.tmdb_id),
      mediaType,
      rating: Number(row.rating),
      title: cached.title,
      ...(cached.year !== undefined ? { year: cached.year } : {}),
      genres: [...cached.genres],
      updatedAt: row.updated_at,
    };
  }
  try {
    const details = await tmdbFetch<TmdbDetailsGenres>(
      `/${mediaType}/${Number(row.tmdb_id)}`,
      { params: { language: "pt-BR" } },
    );
    const title = (mediaType === "movie" ? details.title : details.name)?.trim();
    if (!title) return null;
    const reverse = getReverseGenreMap();
    const genres: GenreKey[] = [];
    for (const genre of details.genres ?? []) {
      for (const g of reverse.get(`${mediaType}:${genre.id}`) ?? []) {
        if (!genres.includes(g)) genres.push(g);
      }
    }
    const year = extractYear(
      mediaType === "movie" ? details.release_date : details.first_air_date,
    );
    cacheSet(key, {
      title,
      ...(year !== undefined ? { year } : {}),
      genres: [...genres],
    });
    return {
      tmdbId: Number(row.tmdb_id),
      mediaType,
      rating: Number(row.rating),
      title,
      ...(year !== undefined ? { year } : {}),
      genres,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/** Ordena amostra: maior |peso| primeiro, depois mais recente. */
function prioritizeSample(rows: RatingSampleRow[]): RatingSampleRow[] {
  return [...rows].sort(
    (a, b) =>
      Math.abs(ratingGenreWeight(Number(b.rating))) -
        Math.abs(ratingGenreWeight(Number(a.rating))) ||
      (b.updated_at > a.updated_at ? 1 : b.updated_at < a.updated_at ? -1 : 0),
  );
}

interface HistorySnapshot {
  watchedKeys: string[];
  watchedCount: number;
  ratedCount: number;
  sample: RatingSampleRow[];
}

/** Lê watched + ratings do usuário DA SESSÃO (RLS vale em cada query). */
async function loadHistorySnapshot(
  supabase: SupabaseClient,
  userId: string,
): Promise<HistorySnapshot> {
  const [watchedRes, ratingsCountRes, sampleRes] = await Promise.all([
    supabase.from("watched_titles").select("tmdb_id,media_type").eq("user_id", userId),
    supabase.from("ratings").select("*", { count: "exact", head: true }).eq("user_id", userId),
    supabase
      .from("ratings")
      .select("tmdb_id,media_type,rating,updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(RATINGS_SAMPLE_LIMIT),
  ]);
  if (watchedRes.error) throw new Error("watched indisponível");
  if (ratingsCountRes.error) throw new Error("ratings indisponíveis");
  if (sampleRes.error) throw new Error("amostra indisponível");

  const watchedRows = (watchedRes.data ?? []) as { tmdb_id: number; media_type: string }[];
  const sample = (sampleRes.data ?? []) as RatingSampleRow[];
  return {
    watchedKeys: watchedRows.map((w) => watchedKey(w.media_type, Number(w.tmdb_id))),
    watchedCount: watchedRows.length,
    ratedCount: ratingsCountRes.count ?? sample.length,
    sample,
  };
}

function emptyPersonalization(version: string): Personalization {
  return { watchedTitleKeys: [], tasteProfile: emptyTasteProfile(version), version };
}

/**
 * Monta a personalização completa. Nunca lança: qualquer falha vira
 * vazio + log seguro (sem PII, sem segredos) e o ranking segue sem ela.
 *
 * `session` opcional: quem já validou o usuário (ex.: páginas de perfil)
 * reutiliza `{ supabase, user }` e economiza 1 roundtrip de auth.
 */
export async function buildPersonalization(
  request: Request,
  cookies: AstroCookies,
  session?: { supabase: SupabaseClient; user: User } | null,
): Promise<Personalization> {
  let supabase: SupabaseClient;
  let user: User | null;
  if (session === undefined) {
    try {
      ({ supabase, user } = await getCurrentUser(request, cookies));
    } catch {
      console.error("[Personalization] Sessão indisponível — seguindo sem histórico.");
      return emptyPersonalization(ANON_TASTE_VERSION);
    }
  } else if (session === null) {
    return emptyPersonalization(ANON_TASTE_VERSION);
  } else {
    ({ supabase, user } = session);
  }
  if (!user) return emptyPersonalization(ANON_TASTE_VERSION);

  let snapshot: HistorySnapshot;
  try {
    snapshot = await perf("taste.history", () => loadHistorySnapshot(supabase, user.id));
  } catch {
    console.error("[Personalization] Histórico indisponível — seguindo sem personalização.");
    return emptyPersonalization(tasteVersion(0, 0, []));
  }

  const updatedAtList = snapshot.sample.map((row) => row.updated_at);
  const version = tasteVersion(snapshot.watchedCount, snapshot.ratedCount, updatedAtList);
  if (snapshot.sample.length === 0) {
    return { watchedTitleKeys: snapshot.watchedKeys, tasteProfile: emptyTasteProfile(version), version };
  }

  // Reuso por versão: amostra inalterada → pula o enriquecimento TMDB.
  const cachedTaste = tasteCacheGet(user.id, snapshot.ratedCount, updatedAtList);
  if (cachedTaste) {
    perfCount("taste.cache.hit", 1);
    return {
      watchedTitleKeys: snapshot.watchedKeys,
      tasteProfile: { ...cachedTaste, version },
      version,
    };
  }
  perfCount("taste.cache.hit", 0);

  const toEnrich = prioritizeSample(snapshot.sample).slice(0, MAX_ENRICH_TITLES);
  perfCount("taste.enrich.titles", toEnrich.length);
  const enriched = await perf("taste.enrich", async () => {
    const settled = await Promise.all(toEnrich.map((row) => enrichRating(row)));
    return settled.filter((e): e is EnrichedRating => e !== null);
  });
  const tasteProfile = buildTasteProfile({
    ratedCount: snapshot.ratedCount,
    version,
    enriched,
  });
  tasteCacheSet(user.id, snapshot.ratedCount, updatedAtList, tasteProfile);
  return {
    watchedTitleKeys: snapshot.watchedKeys,
    tasteProfile,
    version,
  };
}

/**
 * Versão barata do histórico (contagens + updated_at[], sem TMDB) para o
 * endpoint de invalidação de cache. Nunca lança.
 */
export async function getPersonalizationVersion(
  request: Request,
  cookies: AstroCookies,
): Promise<string> {
  try {
    const { supabase, user } = await getCurrentUser(request, cookies);
    if (!user) return ANON_TASTE_VERSION;
    const [watchedRes, ratingsCountRes, stampsRes] = await Promise.all([
      supabase.from("watched_titles").select("*", { count: "exact", head: true }).eq("user_id", user.id),
      supabase.from("ratings").select("*", { count: "exact", head: true }).eq("user_id", user.id),
      supabase
        .from("ratings")
        .select("updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(RATINGS_SAMPLE_LIMIT),
    ]);
    if (watchedRes.error || ratingsCountRes.error || stampsRes.error) {
      return tasteVersion(0, 0, []);
    }
    const stamps = ((stampsRes.data ?? []) as { updated_at: string }[]).map(
      (row) => row.updated_at,
    );
    return tasteVersion(
      watchedRes.count ?? 0,
      ratingsCountRes.count ?? 0,
      stamps,
    );
  } catch {
    return tasteVersion(0, 0, []);
  }
}
