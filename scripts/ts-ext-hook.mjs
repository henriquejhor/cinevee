/**
 * Hook ESM só para scripts de verificação: resolve imports relativos sem
 * extensão para `.ts` (como o Vite/Astro fazem). Uso:
 *   import { register } from "node:module";
 *   register("./ts-ext-hook.mjs", import.meta.url);
 *   const mod = await import("../src/lib/....ts");
 * Nunca usado em produção.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const isRelative =
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("file:");
    if (!isRelative) throw error;
    const parentPath = context.parentURL.startsWith("file:")
      ? fileURLToPath(context.parentURL)
      : context.parentURL;
    const base = path.resolve(path.dirname(parentPath), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate) && candidate.endsWith(".ts")) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    throw error;
  }
}
