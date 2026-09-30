# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Cinéfilos casuais que querem descobrir rapidamente o que assistir, principalmente em momentos de lazer.

O usuário pode acessar o CineVee em dispositivos móveis ou desktop, mas a experiência principal deve ser otimizada para mobile.

O usuário não precisa necessariamente conhecer gêneros, diretores ou termos técnicos de cinema. O produto deve ajudá-lo a decidir com base no momento, humor e preferências de forma simples.

## Product Purpose

CineVee é uma aplicação inteligente de descoberta de filmes e séries.

Seu principal objetivo é reduzir a dificuldade e o tempo gasto escolhendo o que assistir.

A experiência principal combina um pequeno questionário interativo com inteligência artificial generativa para interpretar as preferências do usuário e sugerir conteúdos personalizados.

Os dados reais dos filmes e séries serão obtidos através da API do TMDB.

O CineVee não deve funcionar apenas como um catálogo ou lista de filmes. Ele deve ajudar o usuário a tomar uma decisão.

## Positioning

O diferencial do CineVee é combinar descoberta tradicional de filmes e séries com uma experiência personalizada guiada por IA.

O usuário poderá:

- explorar conteúdos em alta;
- visualizar filmes populares;
- visualizar séries populares;
- encontrar conteúdos bem avaliados;
- pesquisar um título específico;
- salvar conteúdos em uma lista pessoal;
- responder um pequeno questionário para receber recomendações personalizadas.

A IA não deverá inventar títulos livremente.

O fluxo futuro de recomendação será aproximadamente:

Respostas do usuário → Gemini interpreta preferências → TMDB retorna candidatos reais → Gemini classifica os candidatos → CineVee apresenta as melhores recomendações.

Isso reduz o risco de recomendações inexistentes ou inconsistentes.

## Operating Context

O usuário poderá acessar a Home e explorar conteúdos diretamente ou iniciar a experiência "Descobrir".

No fluxo de descoberta:

1. O usuário informa se deseja filme, série ou tanto faz.
2. Responde aproximadamente 4 ou 5 perguntas sobre seu momento e preferências.
3. As respostas são interpretadas pela IA.
4. O TMDB fornece candidatos reais compatíveis.
5. A IA ajuda a classificar os candidatos.
6. O CineVee apresenta aproximadamente 3 ou 4 recomendações.

Cada recomendação poderá futuramente apresentar:

- pôster;
- título;
- sinopse;
- ano ou data de lançamento;
- nota;
- gêneros;
- duração quando aplicável;
- trailer;
- onde assistir;
- explicação de por que aquela recomendação combina com o usuário.

O usuário também poderá refinar uma recomendação sem necessariamente refazer todo o questionário, por exemplo:

- mais recente;
- mais curto;
- mais leve;
- mais intenso;
- mais bem avaliado;
- menos conhecido.

## Core User Journey

Home → Descobrir → Perguntas → Processamento → Recomendações → Detalhes

Fluxos complementares:

Home → Buscar → Detalhes

Home → Conteúdo → Detalhes

Home → Lista

## MVP

A primeira versão do produto deve incluir:

- Home;
- filmes e séries;
- navegação inferior flutuante;
- pesquisa;
- questionário de recomendação;
- aproximadamente 3 ou 4 recomendações;
- explicação de por que cada recomendação combina com o usuário;
- página de detalhes;
- trailer quando disponível;
- disponibilidade em streaming quando disponível;
- salvamento local da lista pessoal;
- persistência local do progresso do questionário;
- persistência local da última recomendação;
- refinamento de recomendações.

A primeira versão NÃO exige conta de usuário.

## Future Features

Funcionalidades futuras poderão incluir:

- autenticação;
- perfis;
- sincronização entre dispositivos;
- histórico de recomendações;
- histórico de conteúdos assistidos;
- avaliações dos usuários;
- comentários;
- preferências persistentes;
- recursos sociais;
- banco de dados em nuvem.

Supabase é a opção prevista para autenticação, perfis, histórico e sincronização futura.

## Capabilities and Constraints

- Questionário interativo auxiliado por Google Gemini
- Integração futura com TMDB para filmes e séries
- Integração futura com TMDB Watch Providers para disponibilidade em streaming
- Persistência inicial através de localStorage
- Nano Stores poderá ser utilizado futuramente para estado reativo compartilhado
- Supabase reservado para funcionalidades que realmente necessitem persistência em nuvem
- Stack frontend: Astro 7, Tailwind CSS 4 e DaisyUI 5
- TypeScript em modo strict
- Interface em português brasileiro (pt-BR)
- Mobile-first
- Não depender de autenticação no MVP
- Não transformar a experiência principal em um chatbot tradicional

## Technology Direction

Frontend:

- Astro 7
- Tailwind CSS 4
- DaisyUI 5
- TypeScript strict

Integrações futuras:

- Google Gemini API
- TMDB API
- TMDB Watch Providers

Persistência inicial:

- localStorage

Gerenciamento de estado futuro quando necessário:

- Nano Stores

Backend e armazenamento futuro:

- Supabase

## Brand Commitments

- Nome: CineVee
- Idioma principal: Português brasileiro
- Direção visual: Cinematic Aurora
- Interface predominantemente escura, limpa e cinematográfica
- Os pôsteres devem fornecer a maior parte das cores da experiência
- A aplicação não deve parecer um clone da Netflix
- O produto deve transmitir descoberta, não catálogo infinito

Mensagem central do produto:

"Não procure o que assistir. Descubra."

CTA principal:

"Descobrir para mim"

## Product Principles

1. Simplicidade acima de tudo.
2. Reduzir a fadiga de decisão.
3. Recomendações devem parecer pessoais, não genéricas.
4. O conteúdo é o protagonista da interface.
5. A experiência deve funcionar especialmente bem em dispositivos móveis.
6. As principais ações devem ser confortáveis para uso com uma mão.
7. O questionário deve parecer uma experiência guiada, não um formulário burocrático.
8. O usuário não deve perder respostas ou recomendações por navegação acidental.
9. A IA deve auxiliar na escolha, enquanto o TMDB fornece a fonte factual dos conteúdos.
10. Evitar complexidade técnica sem benefício claro para o usuário.

## Accessibility & Inclusion

A acessibilidade deve fazer parte da implementação desde o início.

Requisitos mínimos:

- touch targets de pelo menos 48x48px;
- navegação utilizável sem hover;
- foco visível para teclado;
- contraste adequado;
- HTML semântico;
- nomes acessíveis em botões e links;
- suporte a prefers-reduced-motion;
- respeito às safe areas de dispositivos móveis.

## Evidence on Hand

Estado inicial do projeto:

- Astro 7 configurado;
- Tailwind CSS 4 configurado;
- DaisyUI 5 configurado;
- TypeScript strict;
- OpenCode configurado;
- AGENTS.md criado;
- Impeccable configurado;
- página inicial ainda em estágio de scaffold;
- integrações externas ainda não implementadas.