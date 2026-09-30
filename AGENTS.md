## Development

When starting the dev server, use background mode:

    astro dev --background

Manage the background server with:

    astro dev stop
    astro dev status
    astro dev logs

## Project

CineVee is a mobile-first movie and TV discovery and recommendation application in Portuguese (Brazilian).

The primary product experience will combine:

- traditional movie and TV discovery;
- search;
- a guided recommendation questionnaire;
- AI-assisted preference interpretation;
- TMDB content data;
- personalized recommendations.

The first development phases are focused on UI/UX and architecture before external API integration.

Current stack:

- Astro 7
- Tailwind CSS 4 using the Vite plugin
- DaisyUI 5
- TypeScript strict mode

Future integrations:

- Google Gemini API
- TMDB API
- TMDB Watch Providers
- Nano Stores if shared reactive state becomes necessary
- Supabase for future authentication, profiles, cloud history and synchronization

Node requirement:

>=22.12.0

as enforced by package.json.

## Core Engineering Principles

### Keep Astro as Astro

Astro is the primary framework.

Do not introduce React, Vue, Svelte or another frontend framework unless explicitly requested or there is a clear architectural reason.

Prefer:

Astro components
+
HTML
+
CSS
+
minimal JavaScript

over client-side framework components.

Do not hydrate components unnecessarily.

### Avoid unnecessary dependencies

Do not install a package simply because it makes a small task easier.

Before adding any dependency:

1. Check whether the project already contains a solution.
2. Check whether Astro, Tailwind, DaisyUI, CSS or browser APIs can solve the problem cleanly.
3. Add a dependency only when it provides meaningful value.

Do not install dependencies without mentioning why they are necessary.

### Mobile-first

The primary usage platform is mobile.

Start UI decisions around approximately:

360px–430px wide screens.

Desktop should progressively enhance the mobile experience.

Do not create a completely different navigation model for desktop.

### One-handed usability

Important mobile controls should be comfortable to access with one hand.

Touch targets must be at least:

48px x 48px.

Never make essential functionality depend exclusively on hover.

### Accessibility

Accessibility is required from the beginning.

Use semantic HTML.

Navigation should use links.

Actions should use buttons.

Provide visible focus states.

Do not remove outlines without a suitable focus-visible replacement.

Interactive icons must have accessible labels where required.

Decorative SVGs should use aria-hidden="true".

Respect prefers-reduced-motion.

Respect device safe areas.

## Product Documentation

Before making substantial UI or product decisions, read:

- PRODUCT.md
- DESIGN.md

These files describe the intended product and visual language.

Avoid contradicting documented product decisions unless explicitly requested.

## Environment

Required future environment variables are stored in `.env`, which must remain gitignored.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API |
| `TMDB_API_KEY` | TMDB API |
| `PUBLIC_SUPABASE_URL` | Future Supabase project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | Future Supabase public anon key |

Important:

The `PUBLIC_` prefix exposes environment variables to the client bundle.

Never expose secrets such as:

- GEMINI_API_KEY
- TMDB_API_KEY

to browser code.

Any future Gemini or protected TMDB calls must run server-side.

## Current Data Strategy

During early UI development, use organized mock data.

Do not integrate external APIs simply to populate prototype content.

Mocks should be stored separately from components whenever appropriate.

Future external data should be normalized before being passed to UI components.

Do not tightly couple UI components to the complete raw TMDB response shape.

Prefer application-level types such as:

    type ContentType = "movie" | "tv";

    interface ContentItem {
      id: number;
      type: ContentType;
      title: string;
      year?: number;
      rating?: number;
      posterUrl?: string;
    }

Extend these types as needed.

## State and Persistence

Do not install a state management library before it is needed.

Initial persistence for:

- unfinished questionnaire progress;
- questionnaire answers;
- last recommendations;
- local watchlist;

should use browser storage where appropriate.

Prefer localStorage for data that should survive closing and reopening the browser.

Nano Stores may be introduced later if shared reactive client state becomes complex enough to justify it.

Supabase is reserved for future cloud persistence and account-related functionality.

## CSS and DaisyUI

Global CSS lives in:

`src/styles/global.css`

and uses Tailwind CSS + DaisyUI.

Prefer DaisyUI semantic tokens and component classes.

Examples:

- bg-base-100
- bg-base-200
- bg-base-300
- text-base-content
- border-base-300
- btn
- btn-primary

Avoid widespread hardcoded colors.

Do not turn every UI element into a DaisyUI predefined component if a simpler Tailwind implementation produces a better result.

DaisyUI should provide semantic design tokens and useful primitives, not limit the visual identity.

## Components

Avoid very large page files.

Extract components when they:

- are reusable;
- represent a meaningful UI concept;
- reduce duplication;
- improve readability.

Do not create dozens of tiny components without benefit.

Expected future component areas may include:

- navigation;
- movie/content cards;
- home sections;
- search;
- questionnaire;
- recommendations;
- content details.

Follow existing project organization when possible.

## Navigation

CineVee's primary navigation is a persistent floating bottom dock.

Expected primary destinations:

- `/`
- `/buscar`
- `/descobrir`
- `/lista`

The Floating Dock should remain visible on mobile and desktop.

Do not replace it with a conventional desktop navbar unless explicitly requested.

The dock must respect:

`env(safe-area-inset-bottom)`.

Pages containing the dock must reserve enough bottom spacing so it does not cover content.

## JavaScript

Prefer the smallest amount of client-side JavaScript necessary.

Do not add JavaScript for interactions that can be handled cleanly using:

- Astro;
- HTML;
- CSS;
- browser APIs.

Avoid heavy carousel libraries.

Horizontal content lists should prefer native scrolling and CSS scroll snap when sufficient.

## Animation

Prefer CSS animations and transitions.

Typical durations should be approximately:

200ms–300ms.

Prefer animation of:

- opacity;
- transform;
- subtle size changes.

Avoid constant decorative animation.

Respect:

`prefers-reduced-motion`.

Do not install an animation library unless there is a meaningful requirement that cannot be solved cleanly with CSS.

## Images

Content posters should reserve their aspect ratio to avoid layout shift.

Typical poster aspect ratio:

2 / 3.

Use lazy loading where appropriate.

Do not integrate TMDB only to obtain placeholder images during visual prototyping.

## TypeScript

TypeScript strict mode is enabled.

Avoid unnecessary `any`.

Use shared interfaces/types when useful.

Model domain concepts rather than leaking external API response shapes throughout the application.

## Routing

Astro file-based routing is used.

Pages live under:

`src/pages/`

Expected MVP routes include:

    /
    /buscar
    /descobrir
    /lista

Future content detail routes may use:

    /titulo/movie/[id]
    /titulo/tv/[id]

Do not implement complex routes before they are needed.

## API Architecture

When Gemini and TMDB integrations are introduced:

- credentials must remain server-side;
- browser components must not receive API secrets;
- external responses should be validated and normalized;
- Gemini should not be treated as the factual source of movie or TV metadata;
- TMDB should provide factual content data;
- AI should assist with preference interpretation, ranking and explanation.

The intended future recommendation flow is:

User answers
→ Gemini interprets preferences
→ TMDB returns real candidates
→ Gemini ranks candidates
→ TMDB provides factual details
→ CineVee presents recommendations

## Performance

Prioritize mobile performance.

Avoid unnecessary hydration.

Avoid rendering excessively large lists.

Avoid unnecessary JavaScript bundles.

Use native browser capabilities when practical.

Prevent layout shift.

Do not load every possible content image immediately.

## Current Scope Discipline

Do not automatically implement future functionality just because it appears in PRODUCT.md.

When working on a specific task, remain within that task's requested scope.

For example, a Home UI task should not automatically introduce:

- Gemini;
- TMDB;
- Supabase;
- authentication;
- Nano Stores;
- database logic.

Avoid speculative architecture that adds complexity without current value.

## Validation

There is currently no dedicated automated test framework or linter configured unless package.json indicates otherwise.

After meaningful changes:

1. Run the project's available checks.
2. At minimum run:

    astro build

or the equivalent npm script if configured.

3. Fix compilation errors.
4. Do not leave broken imports.
5. Do not leave references to nonexistent routes unless intentionally documented.

## Documentation

Full Astro documentation:

https://docs.astro.build

Useful guides:

- Routing:
  https://docs.astro.build/en/guides/routing/

- Astro components:
  https://docs.astro.build/en/basics/astro-components/

- Framework components:
  https://docs.astro.build/en/guides/framework-components/

- Content collections:
  https://docs.astro.build/en/guides/content-collections/

- Styling:
  https://docs.astro.build/en/guides/styling/

- Internationalization:
  https://docs.astro.build/en/guides/internationalization/