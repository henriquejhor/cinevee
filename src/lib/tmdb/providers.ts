/**
 * Região e resolução de Watch Providers (server-side).
 *
 * - Região única do CineVee nesta etapa: Brasil ("BR").
 * - Os IDs numéricos do TMDB NÃO são espalhados pela aplicação:
 *   a UI usa chaves internas estáveis (`netflix` | `prime` | `disney` | `max`)
 *   e esta camada resolve cada chave para o provider real no catálogo BR
 *   via GET /watch/providers/movie e /watch/providers/tv.
 */
import type { StreamingProvider } from "../../types/content";
import { tmdbFetch } from "./client";

/** Região de disponibilidade do CineVee (única fonte — não espalhar "BR"). */
export const TMDB_WATCH_REGION = "BR";

/** Filtros aceitos pela seção de streamings (chips da Home + /api/streaming). */
export type StreamingFilter = StreamingProvider | "all";

export const STREAMING_FILTERS: readonly StreamingFilter[] = [
  "all",
  "netflix",
  "prime",
  "disney",
  "max",
];

interface TmdbProviderEntry {
  provider_id: number;
  provider_name: string;
}

interface TmdbProvidersResponse {
  results: TmdbProviderEntry[];
}

/**
 * Variações de nome aceitas por chave interna (comparação normalizada).
 * O catálogo BR pode usar "HBO Max" hoje e "Max" amanhã — ambas resolvem
 * para a chave `max`. Correspondência exata após normalização (sem
 * substring) para não confundir, ex.: "Max" com "Cinemax".
 */
const PROVIDER_ALIASES: Record<StreamingProvider, string[]> = {
  netflix: ["netflix"],
  prime: ["amazonprimevideo", "primevideo"],
  disney: ["disneyplus"],
  max: ["max", "hbomax"],
};

/** "Disney Plus" → "disneyplus" · "HBO Max" → "hbomax". */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findProviderId(
  entries: TmdbProviderEntry[],
  aliases: string[],
): number | undefined {
  for (const alias of aliases) {
    const found = entries.find(
      (entry) => normalizeName(entry.provider_name) === alias,
    );
    if (found) return found.provider_id;
  }
  return undefined;
}

// Cache em memória (server-side): o catálogo de providers muda raramente.
let cachedIds: Partial<Record<StreamingProvider, number>> | null = null;

/**
 * Resolve as chaves internas para os IDs reais do TMDB no Brasil.
 * Lança erro se algum dos quatro não for encontrado (o chamador decide
 * o fallback). Nunca expõe nada ao navegador — só IDs numéricos públicos.
 */
export async function getStreamingProviderIds(): Promise<
  Record<StreamingProvider, number>
> {
  if (cachedIds) {
    const complete = (["netflix", "prime", "disney", "max"] as const).every(
      (key) => typeof cachedIds?.[key] === "number",
    );
    if (complete) return cachedIds as Record<StreamingProvider, number>;
  }

  const [movies, series] = await Promise.all([
    tmdbFetch<TmdbProvidersResponse>("/watch/providers/movie", {
      params: { watch_region: TMDB_WATCH_REGION, language: "pt-BR" },
    }),
    tmdbFetch<TmdbProvidersResponse>("/watch/providers/tv", {
      params: { watch_region: TMDB_WATCH_REGION, language: "pt-BR" },
    }),
  ]);

  const resolved: Partial<Record<StreamingProvider, number>> = {};
  const missing: StreamingProvider[] = [];

  for (const key of ["netflix", "prime", "disney", "max"] as const) {
    // Lista de filmes tem prioridade; a de séries serve de reserva.
    const id =
      findProviderId(movies.results, PROVIDER_ALIASES[key]) ??
      findProviderId(series.results, PROVIDER_ALIASES[key]);
    if (id === undefined) {
      missing.push(key);
      console.warn(
        `[TMDB] Watch provider "${key}" não encontrado no catálogo ${TMDB_WATCH_REGION}.`,
      );
    } else {
      resolved[key] = id;
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `[TMDB] Providers ausentes no catálogo ${TMDB_WATCH_REGION}: ${missing.join(", ")}.`,
    );
  }

  cachedIds = resolved;
  return resolved as Record<StreamingProvider, number>;
}
