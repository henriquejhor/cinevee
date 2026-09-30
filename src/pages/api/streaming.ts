/**
 * Rota interna de streamings — GET /api/streaming?provider=<filtro>
 *
 * Filtros permitidos: all | netflix | prime | disney | max.
 * Qualquer outro valor responde 400.
 *
 * O navegador chama SOMENTE esta rota; ela fala com o TMDB server-side
 * (discover com watch_region=BR). O token nunca sai do servidor:
 * nem no JSON, nem no HTML, nem nos logs enviados ao cliente.
 *
 * Resposta de sucesso: `{ "results": ContentItem[] }` (até 12 itens).
 * Resposta de erro: `{ "error": "<mensagem genérica>" }` (sem stack trace).
 */
import type { APIRoute } from "astro";
import { STREAMING_FILTERS, type StreamingFilter } from "../../lib/tmdb/providers";
import { getStreamingContent } from "../../lib/tmdb/streaming";

export const prerender = false;

const GENERIC_ERROR = "Não foi possível carregar este streaming agora.";

function isStreamingFilter(value: string): value is StreamingFilter {
  return (STREAMING_FILTERS as readonly string[]).includes(value);
}

export const GET: APIRoute = async ({ url }) => {
  const provider = (url.searchParams.get("provider") ?? "").trim().toLowerCase();

  if (!isStreamingFilter(provider)) {
    return Response.json({ error: "Filtro de streaming inválido." }, { status: 400 });
  }

  try {
    const results = await getStreamingContent(provider);
    return Response.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha no streaming "${provider}" (${message}).`);
    return Response.json({ error: GENERIC_ERROR }, { status: 502 });
  }
};
