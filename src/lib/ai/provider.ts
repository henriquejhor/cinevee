/**
 * Camada de provider de IA do CineVee.
 *
 * Conceito:
 * - `AIProvider`: chooseAdaptiveQuestion + rankRecommendations;
 * - `groqProvider` (src/lib/ai/groqProvider.ts) = PRIMÁRIO;
 * - Gemini (src/lib/gemini/) = FALLBACK TEMPORÁRIO;
 * - fallback local determinístico = ÚLTIMA camada.
 *
 * Fluxo (sem retries agressivos — uma falha cai direto para a próxima
 * camada, sem quebrar a experiência):
 * - adaptativa: Groq → Gemini → mock local (aplicado pelo endpoint);
 * - ranking:    Groq → Gemini → rankLocally.
 *
 * `AiSource` ("groq" | "gemini" | "local") alimenta log server-side seguro
 * e `meta` em DEV — nunca exibido ao usuário, nunca com segredos.
 */
import type { DiscoveryAnswers } from "../../types/discovery";
import type { RecommendationRefinement } from "../../types/discovery";
import type { RecommendationCandidate } from "../discovery/candidates";
import {
  getAdaptivePick,
  type AdaptiveCategory,
  type AdaptiveContext,
  type AdaptivePick,
} from "../gemini/adaptiveQuestion";
import {
  rankLocally,
  rankWithGemini,
  type RecommendationResult,
} from "../gemini/rankRecommendations";
import { chooseAdaptiveQuestionGroq, rankWithGroq } from "./groqProvider";
import type { TasteProfile } from "../personalization/taste";
import { perf, perfSync } from "../perf";

export type AiSource = "groq" | "gemini" | "local";

export interface AdaptiveOutcome {
  pick: AdaptivePick;
  source: AiSource;
}

export interface RankOutcome {
  result: RecommendationResult;
  source: AiSource;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "erro desconhecido";
}

/**
 * Pergunta adaptativa: Groq → Gemini. Lança erro se ambos falharem —
 * o endpoint aplica o mock local (`getFallbackQuestion`, source "local").
 */
export async function chooseAdaptiveQuestion(
  context: AdaptiveContext,
  recentQuestionIds: string[] = [],
  recentCategories: AdaptiveCategory[] = [],
): Promise<AdaptiveOutcome> {
  try {
    const pick = await chooseAdaptiveQuestionGroq(context, recentQuestionIds, recentCategories);
    return { pick, source: "groq" };
  } catch (error) {
    console.error(`[AI] Adaptativa Groq indisponível (${safeMessage(error)}) — tentando Gemini.`);
  }
  const pick = await getAdaptivePick(context, recentQuestionIds, recentCategories);
  return { pick, source: "gemini" };
}

/**
 * Ranking: Groq → Gemini → rankLocally. Nunca lança por causa de IA —
 * só por pool vazio (erro do chamador). `refinement` (UM por vez ou
 * null) ajusta pool (no endpoint) + ranking sem refazer as respostas.
 * `taste` (opcional) é o gosto histórico compacto — sinal secundário
 * nos três rankers, com as mesmas regras conceituais.
 */
export async function rankRecommendations(
  answers: DiscoveryAnswers,
  candidates: RecommendationCandidate[],
  refinement: RecommendationRefinement | null = null,
  taste: TasteProfile | null = null,
): Promise<RankOutcome> {
  if (candidates.length === 0) {
    throw new Error("[Discovery] Pool de candidatos vazio.");
  }
  try {
    const ranked = await perf("discovery.ai.groq", () =>
      rankWithGroq(answers, candidates, refinement, taste),
    );
    const [primary, ...alternatives] = ranked;
    return { result: { primary: primary ?? null, alternatives }, source: "groq" };
  } catch (error) {
    console.error(`[AI] Ranking Groq indisponível (${safeMessage(error)}) — tentando Gemini.`);
  }
  try {
    const ranked = await perf("discovery.ai.gemini", () =>
      rankWithGemini(answers, candidates, refinement, taste),
    );
    const [primary, ...alternatives] = ranked;
    return { result: { primary: primary ?? null, alternatives }, source: "gemini" };
  } catch (error) {
    console.error(`[AI] Ranking Gemini indisponível (${safeMessage(error)}) — usando fallback local.`);
  }
  const ranked = perfSync("discovery.ai.local", () =>
    rankLocally(answers, candidates, refinement, taste),
  );
  const [primary, ...alternatives] = ranked;
  return { result: { primary: primary ?? null, alternatives }, source: "local" };
}
