/**
 * POST /api/discovery/replacement — substitui UM slot de recomendação
 * (Etapa 10). Reutiliza o pipeline completo da Etapa 8 (profile, watched,
 * TasteProfile, hard constraints, refinement) — nunca um ranking simplificado.
 *
 * Body:
 * - `answers`: DiscoveryAnswers completo e válido (nunca userId/perfil);
 * - `refinement`: UM refinamento ou null (o ATIVO na tela);
 * - `excludeIds`: ["movie:123", …] — os 4 exibidos + recentlySeen (validados);
 * - `slotKey`: "movie:123" — o slot a substituir (força exclusão server-side).
 *
 * Resposta: `{ recommendation: { item, reason }, contextVersion }`.
 * Pool vazio → 502 amigável (o client mantém o estado real do usuário).
 */
import type { APIRoute } from "astro";
import { buildCandidates } from "../../../lib/discovery/candidates";
import { buildRecommendationContext } from "../../../lib/discovery/userPreferences";
import {
  isCompleteAnswers,
  isSeenId,
  parseAnswers,
  parseRefinement,
  parseSeenIds,
} from "../../../lib/discovery/state";
import { rankRecommendations } from "../../../lib/ai/provider";
import { perf } from "../../../lib/perf";

export const prerender = false;

const INVALID = "Dados inválidos.";
const GENERIC_ERROR = "Não foi possível buscar outra recomendação.";

export const POST: APIRoute = async ({ request, cookies }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  if (typeof raw !== "object" || raw === null) {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;

  const answers = parseAnswers(body.answers);
  if (!answers || !isCompleteAnswers(answers)) {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  const refinement = parseRefinement(body.refinement ?? null);
  if (refinement === undefined) {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  const excludeIds = parseSeenIds(body.excludeIds ?? []);
  if (!excludeIds) {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  if (!isSeenId(body.slotKey)) {
    return Response.json({ error: INVALID }, { status: 400 });
  }
  const slotKey = body.slotKey as string;

  try {
    return await perf("replacement.total", async () => {
      // Mesmo contexto do recommendations: profile + watched + taste.
      // Browser nunca envia dados privados — tudo deriva da sessão.
      const context = await buildRecommendationContext(request, cookies, answers);
      const pool = await buildCandidates(context.answers, {
        excludeIds: [...new Set([...excludeIds, slotKey])],
        refinement,
        effectiveExcludedGenres: context.effectiveExcludedGenres,
        watchedExcludeIds: context.watchedTitleKeys,
      });
      if (pool.candidates.length === 0) {
        return Response.json({ error: GENERIC_ERROR }, { status: 502 });
      }
      const { result } = await rankRecommendations(
        answers,
        pool.candidates,
        refinement,
        context.tasteProfile,
      );
      const pick = result.primary ?? result.alternatives[0] ?? null;
      if (!pick) {
        return Response.json({ error: GENERIC_ERROR }, { status: 502 });
      }
      return Response.json({
        recommendation: { item: pick.item, reason: pick.reason },
        contextVersion: context.personalizationVersion,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[Discovery] Replacement indisponível (${message}).`);
    return Response.json({ error: GENERIC_ERROR }, { status: 502 });
  }
};
