/**
 * GET /api/explore — página de resultados do Explore (Etapa 11).
 *
 * Params (todos validados, allowlist — nada arbitrário chega ao TMDB):
 * - `section`: slug do preset (desconhecido → 404);
 * - `tipo`: movie|tv|all (preset fixo coage para o próprio tipo);
 * - `genero`: GenreKey|all (inválido → all);
 * - `ano`: 1900..ano atual (inválido → sem filtro);
 * - `streaming`: netflix|prime|disney|max|all (inválido → all);
 * - `page`: inteiro 1..1000 (inválido → 400).
 *
 * Resposta: `{ items: ContentItem[], page, totalPages, hasMore,
 * appliedFilters }`. Falha TMDB → 502 amigável (sem erro bruto).
 */
import type { APIRoute } from "astro";
import { getExplorePreset } from "../../lib/explore/presets";
import { parseExploreFilters, parseExplorePage } from "../../lib/explore/filters";
import { fetchExplorePage } from "../../lib/explore/service";

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const preset = getExplorePreset(url.searchParams.get("section") ?? "");
  if (!preset) {
    return Response.json({ error: "Seção não encontrada." }, { status: 404 });
  }
  const page = parseExplorePage(url.searchParams.get("page"));
  if (page === null) {
    return Response.json({ error: "Página inválida." }, { status: 400 });
  }
  const filters = parseExploreFilters(preset, (name) => url.searchParams.get(name));

  try {
    const result = await fetchExplorePage(preset, filters, page);
    return Response.json({
      items: result.items,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
      appliedFilters: result.appliedFilters,
      unsupportedCombination: result.unsupportedCombination,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Explore] Falha em ${preset.slug} p${page} (${message}).`);
    return Response.json(
      { error: "Não foi possível carregar os títulos agora." },
      { status: 502 },
    );
  }
};
