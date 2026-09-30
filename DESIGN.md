# CineVee Design System

## Design Direction

Nome conceitual:

Cinematic Aurora

A interface do CineVee deve ser escura, cinematográfica, moderna e minimalista.

A estética deve transmitir descoberta e imersão sem parecer uma plataforma tradicional de streaming.

O CineVee NÃO deve parecer um clone da Netflix.

O princípio visual central é:

"O conteúdo é o protagonista; a interface existe para valorizá-lo."

Os pôsteres e backdrops dos filmes e séries devem fornecer a maior parte das cores da experiência.

A interface deve permanecer predominantemente neutra.

## Visual Personality

A interface deve transmitir:

- cinema;
- descoberta;
- simplicidade;
- tecnologia;
- sofisticação;
- leveza;
- personalidade.

Evitar aparência de:

- dashboard SaaS;
- painel administrativo;
- catálogo congestionado;
- clone de serviço de streaming;
- interface excessivamente futurista;
- neon exagerado.

## Mobile First

O CineVee deve ser projetado primeiro para telas aproximadamente entre:

360px e 430px.

Desktop é uma expansão da experiência mobile, não uma interface completamente diferente.

A principal plataforma de utilização é mobile.

As ações mais importantes devem funcionar confortavelmente com uma mão.

Todo elemento interativo relevante deve possuir área de toque mínima de:

48px x 48px.

Nenhuma funcionalidade essencial pode depender exclusivamente de hover.

Hover pode ser utilizado apenas como melhoria em dispositivos desktop.

## DaisyUI

Priorizar tokens semânticos do DaisyUI.

Exemplos:

- bg-base-100
- bg-base-200
- bg-base-300
- text-base-content
- text-base-content/60
- border-base-300
- primary
- primary-content
- secondary
- accent

Evitar espalhar valores de cor hardcoded pelos componentes.

Se algum valor customizado for realmente necessário, mantê-lo centralizado e fácil de substituir.

## Color Philosophy

A base da aplicação deve ser escura e neutra.

A UI não deve competir com os pôsteres.

Evitar:

- vermelho dominante;
- dezenas de cores de interface;
- gradientes fortes em todos os elementos;
- bordas neon;
- botões multicoloridos.

Pode existir um glow ou efeito aurora extremamente sutil em pontos específicos, principalmente no Hero e em telas de recomendação.

O efeito deve parecer atmosférico, não decorativo.

## Posters

Pôsteres são os principais elementos visuais do CineVee.

Proporção padrão:

2:3

No mobile, cards de pôster podem ter aproximadamente:

135px a 150px de largura.

O pôster deve ocupar a maior parte do card.

Informações abaixo do pôster devem ser simples:

- título;
- ano;
- nota.

Não colocar informações demais nos cards da Home.

Sinopse, elenco, duração e outras informações pertencem às páginas de detalhes.

Evitar border-radius exageradamente alto nos pôsteres.

## Content Carousels

No mobile, listas de conteúdo devem utilizar scroll horizontal natural.

Preferir:

- flex;
- overflow-x-auto;
- scroll-snap;
- gap.

Evitar bibliotecas de carousel enquanto CSS nativo for suficiente.

O layout deve permitir que uma pequena parte do próximo card apareça na lateral, indicando naturalmente que existe mais conteúdo.

No mobile, não depender de setas.

No desktop, controles discretos podem ser utilizados caso melhorem a experiência.

## Floating Dock

A navegação principal do CineVee será uma dock flutuante inferior.

A inspiração conceitual é a Astro Dev Toolbar, mas o componente deve ter identidade própria.

A dock deve permanecer SEMPRE visível.

Isso vale para:

- mobile;
- tablet;
- desktop.

Destinos principais:

- Home
- Buscar
- Descobrir
- Lista

Estrutura conceitual:

Home | Buscar | Descobrir | Lista

O item atualmente ativo deve possuir maior destaque e pode mostrar ícone + texto.

Os demais podem permanecer apenas com ícone.

A dock deve ser compacta.

Ela deve utilizar:

- superfície semitransparente;
- backdrop blur discreto;
- border sutil;
- shadow suave;
- cantos arredondados;
- transições rápidas.

Não exagerar no glassmorphism.

A dock deve respeitar:

env(safe-area-inset-bottom)

Exemplo conceitual de posicionamento:

bottom: calc(1rem + env(safe-area-inset-bottom))

As páginas devem possuir padding inferior suficiente para evitar que conteúdos fiquem escondidos atrás da dock.

## Navigation Behaviour

A navegação deve permanecer consistente em todo o produto.

Não substituir a Floating Dock por navbar tradicional no desktop.

O estado ativo pode expandir discretamente.

Transições devem durar aproximadamente:

200ms a 300ms.

Evitar alterações bruscas de largura que causem layout shift visual desagradável.

## Home

A Home deve priorizar:

1. identidade do CineVee;
2. CTA "Descobrir para mim";
3. descoberta de conteúdos;
4. navegação.

Estrutura inicial:

- Header simples;
- Hero;
- Em alta;
- Novidades nos streamings;
- Muito bem avaliados;
- Filmes populares;
- Séries populares;
- Floating Dock.

O Header deve ser simples.

Não adicionar menu hambúrguer, notificações ou várias ações sem necessidade.

## Hero

Mensagem principal:

"O que vamos assistir hoje?"

Mensagem secundária sugerida:

"Encontre filmes e séries que combinam com seu momento."

CTA:

"Descobrir para mim"

O Hero deve ter bastante espaço negativo.

Não utilizar banners gigantes tradicionais de streaming.

Pode existir uma aurora/glow muito discreta no fundo.

No mobile, parte da próxima seção deve ficar perceptível para sugerir que existe conteúdo abaixo.

## Questionnaire Experience

O questionário futuro deve parecer uma experiência guiada, não um formulário.

Uma pergunta deve dominar a tela por vez.

Exemplo:

Pergunta 2 de 5

Como você quer se sentir hoje?

[ Quero algo divertido ]
[ Quero sentir tensão ]
[ Quero me emocionar ]
[ Quero algo que me faça pensar ]

[ Tanto faz ]

A interface deve possuir:

- progresso;
- animações discretas;
- opções grandes;
- poucas distrações;
- respostas persistidas imediatamente.

A Floating Dock pode permanecer visível, mas mais discreta durante o questionário.

## Recommendation Experience

Os resultados não devem parecer apenas uma grade de quatro cards iguais.

A melhor recomendação deve receber maior destaque.

Estrutura conceitual:

Recomendação principal

+ aproximadamente três alternativas.

A principal recomendação deverá futuramente exibir uma explicação curta:

"Por que combina com você?"

Essa explicação é um dos diferenciais do produto.

## Refinement

Depois de receber uma recomendação, o usuário poderá futuramente refiná-la sem refazer todo o questionário.

Exemplos:

- Mais recente
- Mais curto
- Mais leve
- Mais intenso
- Mais bem avaliado
- Menos conhecido

Esses controles devem utilizar chips simples e facilmente tocáveis.

## Depth

Utilizar profundidade de forma discreta.

Preferir:

- border border-base-300;
- diferenças entre bg-base-100 e bg-base-200;
- shadow suave;
- backdrop blur apenas onde fizer sentido.

Evitar sombras fortes em todos os elementos.

## Borders

Bordas devem ser sutis.

Não envolver todos os componentes em caixas.

Cards podem depender mais de espaçamento e contraste entre superfícies do que de bordas explícitas.

## Typography

Tipografia deve ser clara e moderna.

Headlines podem ter peso alto, mas não devem ocupar a tela inteira.

Textos secundários devem possuir contraste reduzido utilizando tokens como:

text-base-content/60

ou equivalente.

Evitar excesso de tamanhos diferentes de texto.

## Motion

Animações devem possuir função.

Preferir aproximadamente:

200ms a 300ms.

Utilizar principalmente:

- opacity;
- transform;
- pequenas mudanças de escala;
- pequenas mudanças de largura.

Evitar:

- bounce;
- parallax exagerado;
- elementos flutuando constantemente;
- glows pulsantes;
- transições longas;
- animações apenas decorativas.

Respeitar:

prefers-reduced-motion.

## Accessibility

Requisitos mínimos:

- touch target de pelo menos 48x48px;
- foco visível;
- contraste adequado;
- labels acessíveis;
- elementos semânticos;
- navegação possível por teclado;
- ícones decorativos com aria-hidden;
- ícones interativos com nomes acessíveis;
- suporte a prefers-reduced-motion;
- safe areas em dispositivos móveis.

## Design Anti-Patterns

Evitar:

- clone da Netflix;
- visual de dashboard;
- excesso de glassmorphism;
- neon exagerado;
- gradiente em todo componente;
- muitas cores;
- sombras fortes;
- bordas em todo lugar;
- muitos badges;
- excesso de informações nos posters;
- desktop-first;
- hover como única forma de descobrir funcionalidade;
- grandes blocos de texto;
- animações que atrasam a experiência.

## Design Principle

Sempre que houver dúvida entre adicionar um elemento visual ou deixar mais espaço para o conteúdo:

prefira o conteúdo.