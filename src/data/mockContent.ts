import type { ContentItem } from "../types/content";

/**
 * Dados mockados para a Home.
 * Estrutura propositalmente próxima do formato normalizado futuro (TMDB → ContentItem),
 * para que a troca por dados reais seja mecânica.
 */

export const trendingNow: ContentItem[] = [
  { id: 1, type: "movie", title: "Aurora Silenciosa", year: 2025, rating: 8.4, hue: 258, provider: "netflix" },
  { id: 2, type: "tv", title: "Maré de Vidro", year: 2024, rating: 8.1, hue: 210, provider: "max" },
  { id: 3, type: "movie", title: "Último Farol", year: 2024, rating: 7.9, hue: 18, provider: "prime" },
  { id: 4, type: "tv", title: "Jardim Neon", year: 2025, rating: 8.7, hue: 320, provider: "disney" },
  { id: 5, type: "movie", title: "Horizonte Partido", year: 2023, rating: 7.6, hue: 150, provider: "netflix" },
  { id: 6, type: "tv", title: "Casa das Marés", year: 2024, rating: 8.0, hue: 200, provider: "max" },
  { id: 7, type: "movie", title: "Noite em Lisboa", year: 2025, rating: 7.8, hue: 280, provider: "prime" },
  { id: 8, type: "tv", title: "Órbita Baixa", year: 2025, rating: 8.9, hue: 230, provider: "disney" },
];

export const streamingFresh: ContentItem[] = [
  { id: 11, type: "movie", title: "Cinza e Mel", year: 2025, rating: 7.7, hue: 30, provider: "netflix" },
  { id: 12, type: "tv", title: "Porto Seguro", year: 2025, rating: 8.2, hue: 190, provider: "netflix" },
  { id: 13, type: "movie", title: "Terra Quente", year: 2024, rating: 7.5, hue: 12, provider: "prime" },
  { id: 14, type: "tv", title: "Linha Tênue", year: 2025, rating: 8.3, hue: 260, provider: "prime" },
  { id: 15, type: "movie", title: "Véu Azul", year: 2024, rating: 7.9, hue: 215, provider: "disney" },
  { id: 16, type: "tv", title: "Ilha do Meio", year: 2024, rating: 8.0, hue: 160, provider: "disney" },
  { id: 17, type: "movie", title: "Meia-Noite em Tuning", year: 2025, rating: 7.4, hue: 300, provider: "max" },
  { id: 18, type: "tv", title: "Arquivo Frio", year: 2025, rating: 8.5, hue: 220, provider: "max" },
];

export const topRated: ContentItem[] = [
  { id: 21, type: "movie", title: "O Peso da Luz", year: 2022, rating: 9.0, hue: 45, provider: "max" },
  { id: 22, type: "tv", title: "Inverno Longo", year: 2023, rating: 8.9, hue: 205, provider: "netflix" },
  { id: 23, type: "movie", title: "Canto Fundo", year: 2021, rating: 8.8, hue: 170, provider: "prime" },
  { id: 24, type: "tv", title: "As Herdeiras", year: 2024, rating: 8.8, hue: 330, provider: "disney" },
  { id: 25, type: "movie", title: "Pedra e Sal", year: 2020, rating: 8.6, hue: 25, provider: "max" },
  { id: 26, type: "tv", title: "Turno da Noite", year: 2023, rating: 8.6, hue: 245, provider: "prime" },
  { id: 27, type: "movie", title: "Vale Aberto", year: 2022, rating: 8.5, hue: 130, provider: "netflix" },
  { id: 28, type: "tv", title: "Sinal Fraco", year: 2024, rating: 8.5, hue: 275, provider: "max" },
];

export const popularMovies: ContentItem[] = [
  { id: 31, type: "movie", title: "Corrida Mansa", year: 2025, rating: 7.8, hue: 8, provider: "netflix" },
  { id: 32, type: "movie", title: "Dois Invernos", year: 2024, rating: 8.1, hue: 195, provider: "prime" },
  { id: 33, type: "movie", title: "Festa no Terraço", year: 2025, rating: 7.2, hue: 55, provider: "disney" },
  { id: 34, type: "movie", title: "Buraco Negro Caseiro", year: 2024, rating: 7.9, hue: 265, provider: "max" },
  { id: 35, type: "movie", title: "Carta para Amanhã", year: 2023, rating: 8.0, hue: 340, provider: "netflix" },
  { id: 36, type: "movie", title: "Motor e Chuva", year: 2025, rating: 7.3, hue: 210, provider: "prime" },
  { id: 37, type: "movie", title: "A Última Sessão", year: 2024, rating: 8.2, hue: 20, provider: "max" },
  { id: 38, type: "movie", title: "Ponto Cego", year: 2025, rating: 7.6, hue: 180, provider: "disney" },
];

export const popularSeries: ContentItem[] = [
  { id: 41, type: "tv", title: "Rua Noventa", year: 2024, rating: 8.3, hue: 250, provider: "netflix" },
  { id: 42, type: "tv", title: "Clube do Amanhecer", year: 2025, rating: 8.1, hue: 35, provider: "disney" },
  { id: 43, type: "tv", title: "Névoa Alta", year: 2023, rating: 8.4, hue: 200, provider: "max" },
  { id: 44, type: "tv", title: "Quarto Andar", year: 2024, rating: 7.9, hue: 290, provider: "prime" },
  { id: 45, type: "tv", title: "Terra Roxa", year: 2025, rating: 8.0, hue: 15, provider: "netflix" },
  { id: 46, type: "tv", title: "Os Vizinhos", year: 2024, rating: 7.7, hue: 140, provider: "prime" },
  { id: 47, type: "tv", title: "Latência", year: 2025, rating: 8.6, hue: 225, provider: "max" },
  { id: 48, type: "tv", title: "Sol de Inverno", year: 2023, rating: 8.2, hue: 50, provider: "disney" },
];
