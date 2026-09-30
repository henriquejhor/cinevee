/**
 * Rota interna da pergunta adaptativa — POST /api/discovery/adaptive-question.
 *
 * O navegador envia {contentType, mood, preferredGenres, sessionExcludedGenres,
 * recentQuestionIds?}; esta rota monta a shortlist, consulta a camada de IA
 * server-side (Groq → Gemini, que escolhe UM questionId) e responde
 * {questionId, category, question, options} — com options vindas SEMPRE
 * da definição local, nunca do modelo.
 *
 * Qualquer falha (validação, timeout, HTTP, esquema) → 400 se o payload
 * for inválido; fallback local silencioso (200) se a IA falhar.
 * GEMINI_API_KEY e GROQ_API_KEY nunca saem do servidor (JSON, HTML, logs).
 */
import type { APIRoute } from "astro";
import {
  bankCategoryOf,
} from "../../../lib/gemini/adaptiveBank";
import {
  buildAdaptiveResponse,
  getFallbackQuestion,
  isAdaptiveCategory,
  type AdaptiveCategory,
  type AdaptiveContext,
} from "../../../lib/gemini/adaptiveQuestion";
import { chooseAdaptiveQuestion } from "../../../lib/ai/provider";
import {
  getDiscoveryUserPreferences,
  mergeExcludedGenres,
} from "../../../lib/discovery/userPreferences";
import {
  CONTENT_TYPE_OPTIONS,
  GENRE_OPTIONS,
  MOOD_OPTIONS,
  type ContentTypeChoice,
  type GenreKey,
  type MoodKey,
} from "../../../types/discovery";

export const prerender = false;

const CONTENT_VALUES = CONTENT_TYPE_OPTIONS.map((o) => o.value);
const MOOD_VALUES = MOOD_OPTIONS.map((o) => o.value);
const GENRE_VALUES = GENRE_OPTIONS.map((o) => o.value);

function isGenreList(value: unknown): value is GenreKey[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item): item is GenreKey =>
        typeof item === "string" && (GENRE_VALUES as readonly string[]).includes(item),
    )
  );
}

function parseBody(raw: unknown): AdaptiveContext | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const { contentType, mood, preferredGenres, sessionExcludedGenres } = body;

  if (
    typeof contentType !== "string" ||
    !(CONTENT_VALUES as readonly string[]).includes(contentType)
  ) {
    return null;
  }
  if (
    typeof mood !== "string" ||
    !(MOOD_VALUES as readonly string[]).includes(mood)
  ) {
    return null;
  }
  if (!isGenreList(preferredGenres)) return null;
  if (!isGenreList(sessionExcludedGenres ?? [])) return null;

  const excluded = (sessionExcludedGenres ?? []) as GenreKey[];

  return {
    contentType: contentType as ContentTypeChoice,
    mood: mood as MoodKey,
    preferredGenres: [...new Set(preferredGenres)],
    excludedGenres: [...new Set(excluded)],
  };
}

export const POST: APIRoute = async ({ request, cookies }) => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Payload inválido." }, { status: 400 });
  }

  const context = parseBody(raw);
  if (!context) {
    return Response.json({ error: "Payload inválido." }, { status: 400 });
  }

  // Exclusões permanentes do profile fundidas server-side (hard constraint
  // também na adaptativa). Deslogado/falha → só as da sessão.
  const prefs = await getDiscoveryUserPreferences(request, cookies);
  context.excludedGenres = mergeExcludedGenres(
    prefs.excludedGenres,
    context.excludedGenres,
  );

  // Histórico recente (opcional): IDs do banco e/ou categorias legadas.
  // IDs válidos excluem perguntas da shortlist; categorias alimentam
  // a nota de evitação. Resto é ignorado (não invalida o payload).
  let recentIds: string[] = [];
  const recentCategories = new Set<AdaptiveCategory>();
  if (typeof raw === "object" && raw !== null) {
    const body = raw as Record<string, unknown>;
    if (Array.isArray(body.recentQuestionIds)) {
      for (const item of body.recentQuestionIds.slice(-10)) {
        if (typeof item !== "string" || item.length === 0 || item.length > 80) {
          continue;
        }
        recentIds.push(item);
        const category = bankCategoryOf(item);
        if (category && isAdaptiveCategory(category)) {
          recentCategories.add(category);
        }
      }
    }
    if (Array.isArray(body.recentCategories)) {
      for (const item of body.recentCategories) {
        if (isAdaptiveCategory(item)) recentCategories.add(item);
      }
    }
  }

  try {
    const { pick, source } = await chooseAdaptiveQuestion(
      context,
      recentIds,
      [...recentCategories],
    );
    // Diagnóstico dev: de onde veio a pergunta (nunca segredos, nunca em prod).
    console.info(`[Discovery] Pergunta adaptativa via ${source}.`);
    const response = buildAdaptiveResponse(pick);
    if (import.meta.env.DEV) {
      return Response.json({ ...response, meta: { aiSource: source } });
    }
    return Response.json(response);
  } catch (error) {
    // Fallback silencioso: o questionário continua normalmente.
    // Log só com contexto técnico seguro (sem chave, sem dados sensíveis).
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[AI] Pergunta adaptativa indisponível (${message}) — usando fallback local.`);
    const fallback = getFallbackQuestion();
    if (import.meta.env.DEV) {
      return Response.json({ ...fallback, meta: { aiSource: "local" } });
    }
    return Response.json(fallback);
  }
};
