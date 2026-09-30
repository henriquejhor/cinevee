/**
 * GET /api/health — liveness do servidor Astro (Etapa 24).
 *
 * Prova apenas que o processo responde. NÃO chama TMDB/Groq/Gemini
 * nem o banco (healthcheck barato para hospedagem). Nunca retorna
 * env, secrets, UUID ou credenciais.
 */
export const prerender = false;

export async function GET(): Promise<Response> {
  return Response.json(
    { ok: true },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
