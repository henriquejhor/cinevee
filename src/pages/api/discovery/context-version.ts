/**
 * GET /api/discovery/context-version — versão opaca do histórico.
 *
 * Permite ao client invalidar recomendações em cache quando assistidos
 * ou avaliações mudam, sem armazenar histórico no localStorage (só a
 * string opaca `v1:w…:r…:u…` ou `v1:anon`). Nunca 401: deslogado recebe
 * a versão anônima. Nunca lança: falha vira versão vazia genérica.
 */
import type { APIRoute } from "astro";
import { getPersonalizationVersion } from "../../../lib/personalization/tasteProfile";

export const prerender = false;

export const GET: APIRoute = async ({ request, cookies }) => {
  const version = await getPersonalizationVersion(request, cookies);
  return Response.json({ version });
};
