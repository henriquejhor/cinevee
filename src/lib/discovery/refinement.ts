/**
 * Refinamento rápido (server-side): intenção extra aplicada ao ranking.
 *
 * Texto de prompt compartilhado por Groq e Gemini (manter sincronizado
 * nos dois providers). Não contém segredos — só instruções de ranking.
 */
import type { RecommendationRefinement } from "../../types/discovery";

/** Linha anexada ao resumo das respostas quando há refinamento ativo. */
export function refinementUserLine(refinement: RecommendationRefinement): string {
  switch (refinement) {
    case "shorter":
      return "Refinamento ativo: shorter — favoreça opções mais curtas e fáceis de consumir entre candidatos compatíveis (o pool já prioriza durações menores nos filmes).";
    case "newer":
      return "Refinamento ativo: newer — favoreça lançamentos mais recentes entre candidatos compatíveis.";
    case "more_intense":
      return "Refinamento ativo: more_intense — favoreça maior intensidade narrativa (tensão, ritmo, conflito, energia) conforme os gêneros e o mood já escolhidos; NÃO reduza a só ação/terror.";
    case "less_popular":
      return "Refinamento ativo: less_popular — favoreça títulos menos populares (hidden gems com boa avaliação), desde que ainda sejam boas opções.";
  }
}

/**
 * Regra de reason com refinamento (sufixo do system, só com refinamento):
 * menção natural, no máximo UMA reason, sem inventar durações.
 */
export const REFINEMENT_REASON_RULE = [
  "A reason pode mencionar o refinamento pedido SOMENTE se soar natural, em no máximo UMA das razões (nunca nas quatro).",
  "Nunca cite durações específicas em minutos — esses dados não estão na lista.",
].join("\n");
