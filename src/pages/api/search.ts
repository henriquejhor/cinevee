/**
 * Rota interna de busca — GET /api/search?q=...
 *
 * O navegador chama esta rota; ela chama o TMDB server-side.
 * O token (`TMDB_ACCESS_TOKEN`) nunca sai do servidor:
 * nem no JSON, nem no HTML, nem nos logs enviados ao cliente.
 *
 * Resposta de sucesso: `{ "results": ContentItem[] }`
 * Resposta de erro: `{ "error": "<mensagem genérica>" }` (sem stack trace).
 */
import type { APIRoute } from "astro";
import { searchTmdb } from "../../lib/tmdb/search";

export const prerender = false;

const GENERIC_ERROR = "Não foi possível realizar a busca agora.";

export const GET: APIRoute = async ({ url }) => {
  const query = (url.searchParams.get("q") ?? "").trim();

  // Query ausente ou curta demais: não chama o TMDB.
  if (query.length < 2) {
    return Response.json({ results: [] });
  }

  try {
    const results = await searchTmdb(query);
    return Response.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    console.error(`[TMDB] Falha na busca por "${query}" (${message}).`);
    return Response.json({ error: GENERIC_ERROR }, { status: 502 });
  }
};
