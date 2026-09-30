/**
 * Client server-side para a API do TMDB.
 *
 * Server-side only: usa `TMDB_ACCESS_TOKEN` (sem prefixo PUBLIC_)
 * via `import.meta.env`. Nunca importar este módulo em scripts
 * client-side nem vazar o token para o navegador/logs.
 *
 * Base: https://api.themoviedb.org/3
 */

const BASE_URL = "https://api.themoviedb.org/3";

function getAccessToken(): string {
  // `process.env`: lido em runtime (adapter Node) — não é embutido no bundle.
  // `import.meta.env`: fallback para dev/prerender.
  const fromProcess =
    typeof process !== "undefined" ? process.env.TMDB_ACCESS_TOKEN : undefined;
  const token =
    fromProcess ?? (import.meta.env.TMDB_ACCESS_TOKEN as string | undefined);
  if (!token) {
    throw new Error(
      "[TMDB] TMDB_ACCESS_TOKEN ausente. Defina a variável no arquivo .env (server-side).",
    );
  }
  return token;
}

export interface TmdbRequestOptions {
  /** Query params extras (ex.: { language: "pt-BR" }). */
  params?: Record<string, string | number | boolean>;
  /** Timeout em ms (padrão: 8000). */
  timeoutMs?: number;
  /**
   * Tentativas em erro transitório 5xx do TMDB (padrão: 1 retry).
   * Só repete a mesma consulta idempotente (GET); 4xx nunca repetem.
   */
  retries?: number;
}

/** Erro específico para HTTP 404 (ex.: ID inexistente no TMDB). */
export class TmdbNotFoundError extends Error {
  constructor(path: string) {
    super(`[TMDB] GET ${path} — HTTP 404 (não encontrado).`);
    this.name = "TmdbNotFoundError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tmdbFetch<T>(
  path: string,
  options: TmdbRequestOptions = {},
): Promise<T> {
  const token = getAccessToken();
  const url = new URL(`${BASE_URL}${path}`);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 8000,
  );

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "tempo esgotado"
        : "falha de rede";
    throw new Error(`[TMDB] GET ${path} — ${reason}.`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "[TMDB] 401 Não autorizado — credencial ausente, incorreta ou do tipo errado.",
      );
    }
    if (response.status === 404) {
      throw new TmdbNotFoundError(path);
    }
    // 5xx transitório (ex.: incidente no índice de região): uma repetição
    // antes de desistir. Demais status falham direto.
    const retries = options.retries ?? 1;
    if (response.status >= 500 && response.status <= 599 && retries > 0) {
      console.warn(
        `[TMDB] GET ${path} — HTTP ${response.status} (tentando novamente).`,
      );
      await sleep(600);
      return tmdbFetch<T>(path, { ...options, retries: retries - 1 });
    }
    throw new Error(`[TMDB] GET ${path} — HTTP ${response.status}.`);
  }

  return (await response.json()) as T;
}
