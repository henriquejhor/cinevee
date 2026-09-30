/**
 * Respostas JSON que NUNCA devem ficar em cache compartilhado (Etapa 24).
 *
 * Várias respostas "públicas" são viewer-specific por causa de BLOCK
 * (A não vê B, C vê): marcá-las como `public` permitiria um CDN
 * entregar a visão de um usuário para outro. Rotas autenticadas
 * (`/api/follows/state`, `/api/followers/mine`, `/api/feed/following`,
 * `/api/notifications*`, `/api/blocks` GET) usam este helper no
 * caminho 200. Erros (4xx/5xx) continuam sem diretiva explícita.
 */
const PRIVATE_NO_STORE = "private, no-store";

export function privateJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}
