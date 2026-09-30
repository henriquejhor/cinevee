/**
 * Rota interna de recomendações — POST /api/discovery/recommendations.
 *
 * Pipeline server-side:
 * DiscoveryAnswers → candidatos TMDB → ranking IA (Groq → Gemini → local)
 * → {primary, alternatives}.
 *
 * - Body = DiscoveryAnswers (validado estritamente + completude) +
 *   opcionais: excludeIds (reroll) e refinement (UM refinamento ou null).
 * - Pool vazio ou TMDB fora → 502 com mensagem amigável (sem stack trace).
 * - IA fora → fallback local dentro do ranking (sempre 200 com reais).
 * - Segredos (GROQ_API_KEY, GEMINI_API_KEY, TMDB_ACCESS_TOKEN) nunca saem do servidor.
 */
import type { APIRoute } from "astro";
import { buildCandidates } from "../../../lib/discovery/candidates";
import { buildRecommendationContext } from "../../../lib/discovery/userPreferences";
import {
  parseAnswers,
  parseRefinement,
  parseSeenIds,
  isCompleteAnswers,
} from "../../../lib/discovery/state";
import type { RecommendationRefinement } from "../../../types/discovery";
import { rankRecommendations } from "../../../lib/ai/provider";
import { perf } from "../../../lib/perf";

export const prerender = false;

const GENERIC_ERROR = "Não conseguimos buscar recomendações agora.";

export const POST: APIRoute = async ({ request, cookies }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Respostas inválidas." }, { status: 400 });
  }

  const answers = parseAnswers(raw);
  if (!answers || !isCompleteAnswers(answers)) {
    return Response.json({ error: "Respostas inválidas." }, { status: 400 });
  }

  // excludeIds opcional: títulos já apresentados (reroll/variedade).
  // Lista validada e limitada; inválida → 400 (não silently ignored).
  let excludeIds: string[] = [];
  if (typeof raw === "object" && raw !== null && "excludeIds" in raw) {
    const parsed = parseSeenIds((raw as Record<string, unknown>).excludeIds);
    if (!parsed) {
      return Response.json({ error: "Respostas inválidas." }, { status: 400 });
    }
    excludeIds = parsed;
  }

  // Refinamento opcional (UM por vez ou null). Ausente → null;
  // valor inválido → 400 (não silently ignored).
  let refinement: RecommendationRefinement | null = null;
  if (typeof raw === "object" && raw !== null && "refinement" in raw) {
    const parsed = parseRefinement((raw as Record<string, unknown>).refinement);
    if (parsed === undefined) {
      return Response.json({ error: "Respostas inválidas." }, { status: 400 });
    }
    refinement = parsed;
  }

  let candidates;
  let watchedExcludedCount = 0;
  let tasteProfile;
  let personalizationVersion = "v1:anon";
  try {
    // Fonte da verdade server-side: exclusões permanentes do profile
    // (sessão autenticada) + sessão atual. Deslogado/falha → só sessão.
    const context = await buildRecommendationContext(request, cookies, answers);
    tasteProfile = context.tasteProfile;
    personalizationVersion = context.personalizationVersion;
    const pool = await perf("discovery.candidates", () =>
      buildCandidates(context.answers, {
        excludeIds,
        refinement,
        effectiveExcludedGenres: context.effectiveExcludedGenres,
        watchedExcludeIds: context.watchedTitleKeys,
      }),
    );
    candidates = pool.candidates;
    watchedExcludedCount = pool.watchedExcludedCount;
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Discovery] Pool de candidatos indisponível (${message}).`);
    return Response.json({ error: GENERIC_ERROR }, { status: 502 });
  }

  if (candidates.length === 0) {
    console.error("[Discovery] Pool de candidatos vazio após filtros.");
    return Response.json({ error: GENERIC_ERROR }, { status: 502 });
  }

  const { result, source } = await perf("discovery.rank", () =>
    rankRecommendations(answers, candidates, refinement, tasteProfile ?? null),
  );
  const ratedCount = tasteProfile?.ratedCount ?? 0;
  const positiveGenres = tasteProfile?.positiveGenres.map((s) => s.genre) ?? [];
  const negativeGenres = tasteProfile?.negativeGenres.map((s) => s.genre) ?? [];
  // Diagnóstico dev: de onde veio o ranking (nunca segredos, nunca em prod).
  console.info(
    `[Discovery] Ranking via ${source === "local" ? "fallback local" : source} (${1 + result.alternatives.length} itens)${refinement ? ` [refinement=${refinement}]` : ""} [taste=${ratedCount > 0 ? `on r${ratedCount} +${positiveGenres.length}/-${negativeGenres.length}` : "off"} watchedX=${watchedExcludedCount}].`,
  );
  // contextVersion sempre (prod e dev): opaco, sem PII — invalida o cache
  // do client quando o histórico muda. meta detalhado só em DEV.
  if (import.meta.env.DEV) {
    return Response.json({
      ...result,
      contextVersion: personalizationVersion,
      meta: {
        aiSource: source,
        tasteProfileUsed: ratedCount > 0,
        ratedCount,
        positiveGenreCount: positiveGenres.length,
        negativeGenreCount: negativeGenres.length,
        positiveGenres,
        negativeGenres,
        watchedExcludedCount,
      },
    });
  }
  return Response.json({ ...result, contextVersion: personalizationVersion });
};
