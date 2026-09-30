/**
 * Instrumentação de performance SOMENTE em DEV.
 *
 * `perf(label, fn)` mede o tempo wall de um trecho server-side e registra
 * `[perf] <label> <ms>ms` via console.info. Em produção (`import.meta.env.DEV
 * === false`) é passthrough puro, sem log e sem overhead relevante.
 *
 * Regras:
 * - nunca logar tokens, emails, IDs, payloads ou segredos — só o label e ms;
 * - nunca importar em código client-side (módulo server-side).
 */
const IS_DEV: boolean =
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV ?? false;

export async function perf<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!IS_DEV) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    console.info(`[perf] ${label} ${Math.max(1, Math.round(performance.now() - start))}ms`);
  }
}

export function perfSync<T>(label: string, fn: () => T): T {
  if (!IS_DEV) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    console.info(`[perf] ${label} ${Math.max(1, Math.round(performance.now() - start))}ms`);
  }
}

/** Contador local por request (sem estado global — soma explícita). */
export function perfCount(label: string, count: number): void {
  if (!IS_DEV) return;
  console.info(`[perf] ${label} ${count}`);
}
