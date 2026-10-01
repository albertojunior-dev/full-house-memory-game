# Mesa Cheia (Full House / Mesa Llena)

A free browser game that trains waitstaff to take a table's order **from memory only** — no notepad, no phone, no shortcuts. Guests "speak" their order out loud (real text-to-speech), and the player has to listen, remember, and register the correct order for every person at the table.

Built as a plain HTML/CSS/JavaScript site — no build step, no frameworks, no dependencies to install.

## Version 10 highlights

- New informative landing page before the training setup, grounded in the game's real features and saved progress.
- Persistent light/dark theme toggle with responsive layouts in both themes.
- Audio stops immediately when the player leaves the listening stage.
- The optional final review is now clearly explained and remains editable before scoring.
- Four difficulty levels, a timed Rush Hour and intentionally similar orders.
- Twelve achievements and a richer dashboard with trends, insights, language and difficulty breakdowns.
- Improved avatar framing, responsive table layout, footer and high-visibility favicon.
- The header and footer brand marks return directly to the informative introduction.
- A compact responsive setup grid and viewport-aware table prevent unnecessary browser zooming.
- The header content now stays aligned inside a controlled maximum width on very wide screens and at reduced zoom levels.
- Setup option descriptions now remain inside their responsive cards at every supported width.
- The footer includes a direct, accessible link to Alberto Junior's GitHub profile.

## Features

- **Gradual practice**: train a full order, drinks only, starters only, or a main course with its side.
- **Natural guest phrasing**: the ten avatars use ten different ways of presenting their orders in every language, instead of repeating one script.
- **Multi-language**: English, Portuguese and Spanish, both for the interface and for the guests' spoken orders.
- **Guests that actually speak**: each avatar has a permanent Azure voice profile in every language. Generated voice packs are assembled on the fly for that guest's order, and a full 10-person table can use 10 genuinely distinct voices. The greeting in "full order" mode also matches the real time of day (morning/afternoon/evening).
- **Configurable tables**: 1–10 guests, three order-taking styles (random, full order per person, or by course), and an optional editable review before final scoring.
- **Four difficulty levels**: Beginner, Normal, Hard and Expert progressively expand the menu and restrict text reveals and manual audio replays, while harder modes award more XP.
- **Similar-order challenge**: pairs of guests can deliberately receive nearly identical orders, forcing the player to remember the small differences between them.
- **Rush Hour**: an optional adaptive countdown adds time pressure to free training, alongside the dedicated Career mission.
- **Menu builder**: play with a random daily menu, or hand-pick which of the ~90 dishes/drinks are on the table.
- **Live seating chart**: an animated table view shows every guest and highlights whoever is currently speaking.
- **Register & score**: after listening, the player registers each guest's order from memory using tappable menu chips, then gets a scored breakdown (per person, per course) with a circular accuracy gauge.
- **Dashboard**: accuracy trend with visible percentages, best score, guests served, average table size, memory strength by course, recent sessions, strengths and weaknesses, plus language and difficulty breakdowns — all stored locally in the browser (`localStorage`).
- **Achievements**: twelve bronze, silver and gold badges reward perfect tables, speed, large groups, multilingual play, Rush Hour, similar orders and Career completion.
- **XP, levels and professional titles**: every completed table awards XP for correct orders, accuracy, answer streaks, speed and large tables, with a moderate error penalty. Ten levels chart the player's path from Service Apprentice to Dining Room Legend.
- **Challenge/Career mode**: nine progressively harder missions introduce larger tables, no-recap services, accuracy targets and a timed Rush Hour, with sequential unlocking, one-to-three-star ratings and first-clear XP bonuses.
- **Progress that respects existing players**: previous session history is converted into XP automatically, and XP can be reset independently without deleting performance statistics.
- **Resilient sessions**: an accidental page refresh mid-table resumes exactly where you left off (`sessionStorage`); leaving on purpose is a deliberate, confirmed action that intentionally does not save the attempt.
- **Mobile-first**: fully responsive, with a collapsible menu panel on small screens.
- **Informative first step**: the landing page explains the training loop, highlights the real voice/language/table range and shows progress already stored in the browser before the player configures a session.
- **Light and dark modes**: the interface follows the saved preference (or the device preference on first visit) and can be switched from the navigation bar.

## Running it locally

This is a static site, so any local web server works. From the project folder:

```bash
python3 -m http.server 5173
```

Then open `http://localhost:5173` in a browser. Opening `index.html` directly via `file://` can work too, but some browsers restrict `<script src>` loading over `file://`, so a local server is the reliable option.

No install step, no `npm`, no build — just the server.

## Project structure

```
index.html      Page structure + base CSS (design tokens, layout, components)
redesign.css    Professional visual layer, responsive refinements and accessibility states
assets/avatars  Transparent, consistently cropped PNG portraits plus optimized WebP versions used by the game
data.js         Static content: menu items, guest names, UI translations, audio/speech segments
app.js          All application logic: game state, rendering, audio playback, storage
assets/audio/   Pre-recorded clips, voice-pack instructions and language folders
```

There is no bundler and no module system — `data.js` and `app.js` are loaded as plain `<script>` tags, in that order, and share the global scope.

## Audio

Voices are **not** generated by the visitor's browser/OS — that was tried first and turned out to be unreliable: available voices (and their quality) vary wildly across devices, and some browsers have bugs where the wrong language plays. Instead, every possible line a guest can say is built from a set of pre-recorded `.mp3` clips generated with Microsoft Azure Speech:

- One clip per dish/drink name and avatar voice (`assets/audio/<lang>/avatar_XX/<menuItemId>.mp3`).
- A handful of fixed "connector phrase" clips per language (`conn_drink_intro`, `conn_principal_mid`, three time-of-day greetings, etc.) — see `SPEECH_SEGMENTS` and `GREETING_CLIPS` in data.js.

At runtime, every avatar resolves to its permanent entry in `VOICE_PROFILES`. `buildAudioPlaylist()` turns the chosen dishes into profile-aware sources. `playClips()` preloads, trims and schedules the fragments through the Web Audio API for natural, low-gap playback, with a standard `<audio>` fallback for compatibility. Audio is cancelled immediately when the player leaves the listening stage. `tools/generate_azure_voices.py` queries the voices available in the configured Azure region, creates previews and generates resumable MP3 packs.

The legacy clips remain in the repo as a safety fallback. See `assets/audio/VOICES.md` for secure Azure setup, preview and generation commands.

## Publishing on GitHub

The generated voice packs contain 2,970 MP3 files (about 38 MB). They are required for the complete voice experience, so they are intentionally not excluded by `.gitignore`. To avoid storing binary audio directly in normal Git history, configure [Git LFS](https://git-lfs.com/) before the first commit:

```bash
git lfs install
git lfs track "*.mp3"
```

This creates a `.gitattributes` file. Commit that file together with the project. Azure credentials must only be supplied through the `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION` environment variables; never write the key into the source code, README or a committed `.env` file.

## Tech notes

- **Storage**: `localStorage` for Dashboard history (capped at 300 sessions), the progression profile, theme and mute preferences; `sessionStorage` for resuming an in-progress table after a refresh. All storage access is wrapped in `try/catch` since it can be unavailable (private browsing, disabled cookies, storage quota).
- **No backend**: everything runs client-side, including audio playback (it's just static files). Nothing is sent to a server, and no personal data is collected.

## Author

Developed by Alberto Junior, Computer Engineering student, with the help of AI.
