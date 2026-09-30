/**
 * Presets do Explore (Etapa 11) — UMA configuração central, zero duplicação.
 *
 * - em-alta / nos-streamings / muito-bem-avaliados: mixed (tipo filtrável);
 * - filmes-populares: movie fixo; series-populares: tv fixo.
 */
import type { ExplorePreset, ExploreSlug } from "./types";

export const EXPLORE_PRESETS: Record<ExploreSlug, ExplorePreset> = {
  "em-alta": {
    slug: "em-alta",
    eyebrow: "Explorar",
    title: "Em alta",
    description: "O que todo mundo está assistindo. Filmes e séries em destaque nesta semana.",
    source: "trending",
    defaultMediaType: "all",
    mediaTypeLocked: false,
  },
  "nos-streamings": {
    slug: "nos-streamings",
    eyebrow: "Explorar",
    title: "Nos streamings",
    description: "Títulos recentes disponíveis por assinatura no Brasil.",
    source: "streaming",
    defaultMediaType: "all",
    mediaTypeLocked: false,
  },
  "muito-bem-avaliados": {
    slug: "muito-bem-avaliados",
    eyebrow: "Explorar",
    title: "Muito bem avaliados",
    description: "Títulos que conquistaram grandes avaliações do público.",
    source: "top_rated",
    defaultMediaType: "all",
    mediaTypeLocked: false,
  },
  "filmes-populares": {
    slug: "filmes-populares",
    eyebrow: "Explorar",
    title: "Filmes populares",
    description: "Os filmes que estão chamando atenção agora.",
    source: "popular_movies",
    defaultMediaType: "movie",
    mediaTypeLocked: true,
  },
  "series-populares": {
    slug: "series-populares",
    eyebrow: "Explorar",
    title: "Séries populares",
    description: "As séries que estão chamando atenção agora.",
    source: "popular_series",
    defaultMediaType: "tv",
    mediaTypeLocked: true,
  },
};

export const EXPLORE_SLUGS = Object.keys(EXPLORE_PRESETS) as ExploreSlug[];

/** Slug da allowlist ou null (rota responde 404). */
export function getExplorePreset(slug: string): ExplorePreset | null {
  if (!EXPLORE_SLUGS.includes(slug as ExploreSlug)) return null;
  return EXPLORE_PRESETS[slug as ExploreSlug];
}
