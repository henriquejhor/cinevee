/**
 * Verificação do bug "Buscar outra opção" (/descobrir → POST replacement).
 *
 * Regressão: o endpoint retornava HTTP 200 com `{ recommendation: { item, reason },
 * contextVersion }` válido, mas o frontend caía em
 * "Não foi possível buscar outra recomendação…" porque `isValidRecommendation`
 * exigia `rank: number` — campo que o contrato do replacement NÃO retorna
 * (só /recommendations retorna rank 1–4; no replacement o slot já define a posição).
 *
 * Uso: node scripts/verify-replacement-frontend.mjs (sem servidor, sem secrets).
 *
 * Cobre (estático + unitário da validação real extraída de flow.ts):
 * - contrato backend inalterado: replacement.ts responde
 *   `{ recommendation: { item, reason }, contextVersion }`;
 * - frontend lê `record.recommendation` + `record.contextVersion`
 *   (sem mismatch recommendation/replacement/item);
 * - payload exato do incidente (Jujutsu Kaisen, sem rank) é aceito;
 * - payload com rank (recommendations) continua aceito;
 * - inválidos continuam rejeitados (sem reason, sem title, rank não-numérico);
 * - rank ausente NÃO pode ser rejeição obrigatória.
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}
const info = (msg) => console.log(`INFO  ${msg}`);

const flowUrl = new URL("../src/lib/discovery/flow.ts", import.meta.url);
const replacementUrl = new URL("../src/pages/api/discovery/replacement.ts", import.meta.url);
const flowSrc = readFileSync(flowUrl, "utf8");
const replacementSrc = readFileSync(replacementUrl, "utf8");

// ------------------------------------------------- A. contrato backend intacto
check(
  "backend: replacement responde { recommendation: { item, reason }, contextVersion }",
  /recommendation:\s*\{\s*item:\s*pick\.item,\s*reason:\s*pick\.reason\s*\}/.test(replacementSrc) &&
    /contextVersion:\s*context\.personalizationVersion/.test(replacementSrc),
);
check(
  "backend: sem rank no replacement (contrato { item, reason })",
  !/recommendation:\s*\{[^}]*\brank\b/.test(replacementSrc),
);

// ------------------------------------------------- B. frontend lê os nomes certos
check(
  "frontend: lê record.recommendation (sem mismatch replacement/recommendation)",
  /const rec =\s*record\.recommendation as/.test(flowSrc) &&
    !/record\.replacement\b/.test(flowSrc),
);
check(
  "frontend: lê record.contextVersion",
  /const version =\s*record\.contextVersion/.test(flowSrc),
);
check(
  "frontend: rank NÃO é exigência obrigatória",
  !/typeof rec\.rank !== "number"\) return false/.test(flowSrc) ||
    /rec\.rank !== undefined && typeof rec\.rank !== "number"/.test(flowSrc),
);

// ------------------------------------------------- C. extrai e executa a validação real
const fnMatch = flowSrc.match(/function isValidRecommendation\(value: unknown\): boolean \{([\s\S]*?)\n  \}/);
check("frontend: isValidRecommendation extraível de flow.ts", !!fnMatch);
if (!fnMatch) {
  console.log("---");
  console.log(`REPLACEMENT-FRONTEND FALHOU: ${failures} asserção(ões).`);
  process.exit(1);
}
// Remove anotações TS para avaliar em JS puro (só os dois `as` existentes no corpo).
const fnBody = fnMatch[1]
  .replace(/ as Record<string, unknown> \| undefined/g, "")
  .replace(/ as Record<string, unknown>/g, "");
const isValidRecommendation = new Function("value", fnBody);

const incidentPayload = {
  recommendation: {
    item: {
      id: 95479,
      type: "tv",
      title: "Jujutsu Kaisen",
      year: 2020,
      rating: 8.6,
      posterUrl: "https://image.tmdb.org/t/p/w500/8R1mMSC1gX1cg5ed7ns49JOEqw3.jpg",
      backdropUrl: "https://image.tmdb.org/t/p/w1280/j2GvamiUMRpPjmNQSSht0Q7Z7e9.jpg",
      genres: ["Animação", "Sci-Fi e fantasia", "Ação e aventura"],
      hue: 79,
    },
    reason:
      "Para quem busca algo novo e rápido, a animação de Jujutsu Kaisen entrega ação intensa e envolvente, ideal para relaxar com ritmo acelerado.",
  },
  contextVersion: "v1:w2:r0:u811c9dc5",
};

// Simula exatamente o ramo de startReplacement():
// response.ok (200) → record.recommendation + isValidRecommendation.
function frontendAccepts(data) {
  if (typeof data !== "object" || data === null) return false;
  const record = data;
  const rec = record.recommendation;
  if (!rec || !isValidRecommendation(rec)) return false;
  return true;
}

check(
  "incidente: 200 + recommendation válida (sem rank) → frontend aceita, sem erro",
  frontendAccepts(incidentPayload),
);
info(`payload incidente aceito: ${incidentPayload.recommendation.item.title}`);

check(
  "recommendations com rank continua aceita",
  frontendAccepts({
    recommendation: { ...incidentPayload.recommendation, rank: 2 },
    contextVersion: "v1:w2:r0:u811c9dc5",
  }),
);
check(
  "inválido sem reason → rejeitado",
  !frontendAccepts({ recommendation: { item: incidentPayload.recommendation.item }, contextVersion: "x" }),
);
check(
  "inválido sem title → rejeitado",
  !frontendAccepts({
    recommendation: {
      item: { ...incidentPayload.recommendation.item, title: "" },
      reason: "motivo válido com tamanho suficiente para passar",
    },
    contextVersion: "x",
  }),
);
check(
  "rank não-numérico → rejeitado",
  !frontendAccepts({
    recommendation: { ...incidentPayload.recommendation, rank: "1" },
    contextVersion: "x",
  }),
);

console.log("---");
console.log(
  failures === 0
    ? "REPLACEMENT-FRONTEND OK: 200 válido substitui o card, sem erro."
    : `REPLACEMENT-FRONTEND FALHOU: ${failures} asserção(ões).`,
);
process.exit(failures === 0 ? 0 : 1);
