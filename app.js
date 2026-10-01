// ============================================================================
// app.js — Mesa Cheia game logic
//
// This file owns everything that changes at runtime: building a table and
// its guests, driving the order-taking / register / recap / results screens,
// playing each guest's pre-recorded order audio, and the persisted history
// behind the Dashboard. It reads content from data.js (menu items,
// translations, audio segment/speech templates) but never modifies it.
// There is no module system — every top-level `const`/`function` here
// shares the same global scope as data.js.
//
// Rough map of the file, in reading order:
//   1. Small generic helpers (shuffle, pickRandom, hashString)
//   2. App state + localStorage-backed history/streak/badge helpers
//   3. Cached DOM references (`els`) + static text binding
//   4. Guest audio: greeting-by-time-of-day and the clip-sequence player
//   5. Table/queue construction (buildTable, buildQueue)
//   6. Screen renderers: order, register, recap, results, menu builder
//   7. Dashboard rendering
//   8. Session persistence (resume after an accidental refresh)
// ============================================================================

// Fisher-Yates shuffle. Returns a new array; never mutates the input.
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks `n` distinct random elements from `arr` (via shuffle), used to build
// a random "menu of the day" and to assign each guest a random dish.
function pickRandom(arr, n) {
  return shuffle(arr).slice(0, n);
}

// Cheap deterministic string hash. Used only to derive a stable-but-varied
// pitch/rate per guest id, so the same guest always sounds the same across
// re-renders, and different guests don't all sound identical.
function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

// Reads the user's saved mute preference. Wrapped in try/catch because
// localStorage can throw (private browsing, disabled storage, quota).
function loadMutedPref() {
  try {
    return localStorage.getItem("mesaCheia.muted") === "true";
  } catch (e) {
    return false;
  }
}

// Single source of truth for "what's happening right now": the selected
// language, the current table (null when on the setup screen), what the
// player has registered so far for that table, and the mute toggle.
const state = {
  lang: "en",
  table: null,
  registered: {},
  muted: loadMutedPref(),
};

// localStorage key for the Dashboard's session history (capped in
// saveHistoryRecord). sessionStorage key for resuming an in-progress table
// after an accidental refresh (see persistSession/restoreSession below).
const HISTORY_KEY = "mesaCheia.history";
const SESSION_KEY = "mesaCheia.session";
const PROFILE_KEY = "mesaCheia.profile";
const CAREER_KEY = "mesaCheia.career";

// Career-ready progression model. XP is earned in normal training for now;
// the future Challenge/Career mode can feed the same awardXP() function.
const LEVELS = [
  { level: 1, xp: 0, titleKey: "titleApprentice" },
  { level: 2, xp: 250, titleKey: "titleRunner" },
  { level: 3, xp: 600, titleKey: "titleCommis" },
  { level: 4, xp: 1100, titleKey: "titleWaiter" },
  { level: 5, xp: 1800, titleKey: "titleSenior" },
  { level: 6, xp: 2700, titleKey: "titleHeadWaiter" },
  { level: 7, xp: 3800, titleKey: "titleMaitre" },
  { level: 8, xp: 5200, titleKey: "titleServiceExpert" },
  { level: 9, xp: 7000, titleKey: "titleRestaurantMaster" },
  { level: 10, xp: 9000, titleKey: "titleLegend" },
];

function levelForXP(totalXp) {
  let current = LEVELS[0];
  for (const entry of LEVELS) {
    if (totalXp >= entry.xp) current = entry;
    else break;
  }
  const index = LEVELS.indexOf(current);
  const next = LEVELS[index + 1] || null;
  const span = next ? next.xp - current.xp : 1;
  const progress = next ? Math.min(99, Math.floor(((totalXp - current.xp) / span) * 100)) : 100;
  return { ...current, next, progress };
}

function calculateXP(result) {
  const wrong = Math.max(0, result.total - result.correct);
  const correctXp = result.correct * 10;
  const errorPenalty = wrong * 2;
  const accuracyBonus = result.pct === 100 ? 50 : result.pct >= 90 ? 30 : result.pct >= 75 ? 15 : 0;
  const comboBonus = Math.min(20, Math.max(0, (result.maxCombo || 0) - 2) * 2);
  const speedBonus = result.elapsedMs && result.elapsedMs <= 3 * 60 * 1000 ? 20 : 0;
  const largeTableBonus = result.peopleCount >= 8 ? 20 : 0;
  const careerBonus = result.careerBonus || 0;
  const base = Math.max(0, correctXp - errorPenalty);
  const subtotal = base + accuracyBonus + comboBonus + speedBonus + largeTableBonus + careerBonus;
  const multiplier = DIFFICULTIES[result.difficulty]?.xpMultiplier || 1;
  const difficultyBonus = Math.max(0, Math.round(subtotal * multiplier) - subtotal);
  return { base, correctXp, errorPenalty, accuracyBonus, comboBonus, speedBonus, largeTableBonus, careerBonus, difficultyBonus,
    total: subtotal + difficultyBonus };
}

function xpFromHistory(history) {
  return history.reduce((sum, record) => sum + (record.xpEarned ?? calculateXP(record).total), 0);
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { totalXp: Math.max(0, Number(saved.totalXp) || 0), initialized: true };
    }
    const migrated = { totalXp: xpFromHistory(loadHistory()), initialized: true };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(migrated));
    return migrated;
  } catch (e) {
    return { totalXp: 0, initialized: false };
  }
}

function saveProfile(profile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
}

function awardXP(amount) {
  const profile = loadProfile();
  const before = levelForXP(profile.totalXp);
  profile.totalXp += Math.max(0, amount);
  saveProfile(profile);
  const after = levelForXP(profile.totalXp);
  updatePlayerSummary(profile);
  return { profile, before, after, leveledUp: after.level > before.level };
}

function loadCareer() {
  try {
    const raw = localStorage.getItem(CAREER_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { missions: saved.missions || {} };
  } catch (e) {
    return { missions: {} };
  }
}

function saveCareer(career) {
  try { localStorage.setItem(CAREER_KEY, JSON.stringify(career)); } catch (e) { /* ignore */ }
}

function evaluateCareerMission(table, pct, elapsedMs) {
  if (!table.careerMissionId) return null;
  const mission = CAREER_MISSIONS.find((item) => item.id === table.careerMissionId);
  if (!mission) return null;
  const accuracyMet = pct >= mission.minPct;
  const timeMet = !mission.maxSeconds || (elapsedMs && elapsedMs <= mission.maxSeconds * 1000);
  const completed = accuracyMet && timeMet;
  const career = loadCareer();
  const previous = career.missions[mission.id] || null;
  let stars = 0;
  if (completed) {
    stars = pct === 100 ? 3 : pct >= Math.min(100, mission.minPct + 10) ? 2 : 1;
    career.missions[mission.id] = {
      completed: true,
      stars: Math.max(stars, previous?.stars || 0),
      bestPct: Math.max(pct, previous?.bestPct || 0),
      bestTimeMs: previous?.bestTimeMs ? Math.min(elapsedMs, previous.bestTimeMs) : elapsedMs,
    };
    saveCareer(career);
  }
  return { mission, completed, stars, accuracyMet, timeMet, firstClear: completed && !previous?.completed };
}

// Reads the Dashboard's session history from localStorage. Each entry is
// one completed table (see the object shape built in renderResultsScreen).
// Returns [] if nothing is stored yet, or if storage is unavailable/corrupt.
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

// Appends one finished table to the history and caps it at 300 entries
// (oldest first) so localStorage doesn't grow without bound over a long
// history of use.
function saveHistoryRecord(record) {
  try {
    const history = loadHistory();
    history.push(record);
    if (history.length > 300) history.splice(0, history.length - 300);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    /* localStorage unavailable — stats just won't persist */
  }
}

// Snapshots the in-progress table to sessionStorage so an accidental page
// refresh doesn't lose the player's progress (see resumeSession() at the
// bottom of this file). `completed` is a Set per guest, which JSON can't
// serialize directly, so it's converted to a plain array first.
function persistSession(screen) {
  if (!state.table) return;
  try {
    const table = state.table;
    const serializableTable = {
      ...table,
      completed: Object.fromEntries(Object.entries(table.completed).map(([k, v]) => [k, [...v]])),
    };
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ lang: state.lang, table: serializableTable, registered: state.registered, screen })
    );
  } catch (e) {
    /* sessionStorage unavailable — resume just won't work */
  }
}

// Drops the in-progress-table snapshot. Called once a table finishes
// normally (results are shown) or the player deliberately exits early —
// in both cases there's nothing left to resume.
function clearSession() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch (e) {
    /* ignore */
  }
}

// Reads back whatever persistSession() last saved, undoing the Set->array
// conversion. Returns null if there's nothing saved, or if the saved data
// is missing/unreadable — callers should treat that as "start fresh".
function restoreSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved.table) return null;
    saved.table.completed = Object.fromEntries(
      Object.entries(saved.table.completed).map(([k, v]) => [k, new Set(v)])
    );
    return saved;
  } catch (e) {
    return null;
  }
}

// Normalizes a timestamp to a "YYYY-M-D" key (local time, no leading zeros)
// so two sessions on the same calendar day always produce the same key,
// regardless of the exact time. Used by computeStreak() below.
function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Computes the Dashboard's "day streak": how many consecutive calendar days
// (ending today or yesterday) had at least one completed table, plus the
// longest such streak ever seen in the history. Consecutive-day counting is
// done on de-duplicated, sorted day timestamps rather than on raw session
// timestamps, since a day can have many sessions.
function computeStreak(history) {
  if (history.length === 0) return { current: 0, best: 0 };
  const days = [...new Set(history.map((r) => dateKey(r.ts)))]
    .map((k) => {
      const [y, m, d] = k.split("-").map(Number);
      return new Date(y, m - 1, d).getTime();
    })
    .sort((a, b) => b - a);

  const oneDay = 86400000;
  let current = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let cursor = today.getTime();
  for (const day of days) {
    if (day === cursor) {
      current++;
      cursor -= oneDay;
    } else if (day === cursor + oneDay && current === 0) {
      continue;
    } else {
      break;
    }
  }

  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i - 1] - days[i] === oneDay) {
      run++;
    } else {
      best = Math.max(best, run);
      run = 1;
    }
  }
  best = Math.max(best, run, current);

  return { current, best };
}

// Aggregates the whole history into the numbers the Dashboard displays:
// overall accuracy, the day streak, per-course accuracy (for the "Memory
// Strength" bars), the most recent sessions, and when the player's first
// session happened (for the "member since" line).
function computeStats(history) {
  const totalTables = history.length;
  let correctSum = 0;
  let totalSum = 0;
  const byCategory = {};
  ["bebida", "entrada", "principal", "acompanhamento", "sobremesa"].forEach((k) => {
    byCategory[k] = { correct: 0, total: 0 };
  });

  history.forEach((r) => {
    correctSum += r.correct;
    totalSum += r.total;
    Object.keys(r.byCategory || {}).forEach((k) => {
      byCategory[k].correct += r.byCategory[k].correct;
      byCategory[k].total += r.byCategory[k].total;
    });
  });

  const accuracyRate = totalSum > 0 ? Math.round((correctSum / totalSum) * 100) : 0;
  const streak = computeStreak(history);
  const recent = [...history].sort((a, b) => b.ts - a.ts).slice(0, 6);
  const firstTs = history.reduce((min, r) => Math.min(min, r.ts), Infinity);
  const bestScore = history.reduce((best, r) => Math.max(best, r.pct || 0), 0);
  const guestsServed = history.reduce((sum, r) => sum + (r.peopleCount || 0), 0);
  const averageTable = totalTables ? (guestsServed / totalTables).toFixed(1) : "0";
  const bestCombo = history.reduce((best, r) => Math.max(best, r.maxCombo || 0), 0);

  return { totalTables, accuracyRate, streak, byCategory, recent, firstTs, bestScore, guestsServed, averageTable, bestCombo };
}

// Derives which achievement badges are unlocked from the raw history plus
// the stats already computed above. Each badge is a simple, independent
// rule over past sessions — see BADGES/badge*Desc in data.js for what each
// one means to the player.
function computeBadges(history, stats) {
  const anyPerfect = history.some((r) => r.total > 0 && r.correct === r.total);
  const bebida = stats.byCategory.bebida;
  const sommelier = bebida.total >= 10 && Math.round((bebida.correct / bebida.total) * 100) >= 90;
  const agile = history.some((r) => r.elapsedMs && r.elapsedMs < 3 * 60 * 1000);
  const cartmaster = stats.totalTables >= 10;
  const gourmet = stats.totalTables >= 25;
  const brigade = history.some((r) => r.peopleCount >= 8);
  const perfectFive = history.filter((r) => r.total > 0 && r.correct === r.total).length >= 5;
  const languages = new Set(history.map((r) => r.lang).filter(Boolean));
  const career = loadCareer();

  return {
    firstService: history.length >= 1,
    elephant: anyPerfect,
    sommelier,
    agile,
    cartmaster,
    gourmet,
    brigade,
    perfectFive,
    polyglot: languages.size >= 3,
    rushMaster: history.some((r) => r.rushHour && r.withinTime && r.pct >= 75),
    confusionProof: history.some((r) => r.similarOrders && r.pct >= 90),
    careerGraduate: CAREER_MISSIONS.every((m) => career.missions[m.id]?.completed),
  };
}

// Shorthand for "the current language's copy". Almost every render function
// starts with `const s = t();` and then reads `s.someKey`.
function t() {
  return UI[state.lang];
}

// Resolves a dish/drink id to its display name in a given language.
function itemName(id, lang) {
  return ALL_ITEMS[id][lang];
}

// Produces one consistent portrait wherever a guest appears. The emoji
// fallback keeps sessions created by older versions of the game usable.
function avatarMarkup(person, extraClass = "") {
  const avatar = person.avatar || "";
  const classes = `guest-avatar ${extraClass}`.trim();
  if (avatar.startsWith("assets/avatars/")) {
    return `<img class="${classes}" src="${avatar}" alt="" draggable="false" />`;
  }
  return `<span class="${classes} guest-avatar-emoji" aria-hidden="true">${avatar}</span>`;
}

function personCardHeader(person) {
  const seat = person.seat || Number(person.id.replace("person_", "")) + 1;
  return `
    <div class="person-card-head">
      <span class="person-card-avatar">${avatarMarkup(person)}</span>
      <span class="person-card-identity">
        <span class="name">${person.name}</span>
        <span class="seat-tag">#${String(seat).padStart(2, "0")}</span>
      </span>
    </div>`;
}

// One-time cache of every DOM element the app touches, keyed by a short
// camelCase name (roughly matching the element's id). Populated once at
// load, since none of these ids are ever recreated — screens are shown/
// hidden, not rebuilt, so a single querySelector per element is enough.
const els = {
  appTitle: document.getElementById("app-title"),
  appSubtitle: document.getElementById("app-subtitle"),
  labelLang: document.getElementById("label-lang"),
  labelPeople: document.getElementById("label-people"),
  labelRecap: document.getElementById("label-recap"),
  recapHelp: document.getElementById("recap-help"),
  labelDifficulty: document.getElementById("label-difficulty"),
  inputDifficulty: document.getElementById("input-difficulty"),
  difficultyHelp: document.getElementById("difficulty-help"),
  labelSimilarOrders: document.getElementById("label-similar-orders"),
  inputSimilarOrders: document.getElementById("input-similar-orders"),
  similarOrdersHelp: document.getElementById("similar-orders-help"),
  labelRushHour: document.getElementById("label-rush-hour"),
  inputRushHour: document.getElementById("input-rush-hour"),
  rushHourHelp: document.getElementById("rush-hour-help"),
  labelMenuMode: document.getElementById("label-menu-mode"),
  labelOrderStyle: document.getElementById("label-order-style"),
  labelTrainingFocus: document.getElementById("label-training-focus"),
  btnStart: document.getElementById("btn-start"),
  inputLang: document.getElementById("input-lang"),
  inputPeople: document.getElementById("input-people"),
  inputRecap: document.getElementById("input-recap"),
  inputMenuMode: document.getElementById("input-menu-mode"),
  inputOrderStyle: document.getElementById("input-order-style"),
  inputTrainingFocus: document.getElementById("input-training-focus"),
  welcomeText: document.getElementById("welcome-text"),
  footerCredit: document.getElementById("footer-credit"),
  footerTitle: document.getElementById("footer-title"),
  footerTagline: document.getElementById("footer-tagline"),
  btnMute: document.getElementById("btn-mute"),
  muteIcon: document.getElementById("mute-icon"),
  btnTheme: document.getElementById("btn-theme"),
  themeIcon: document.getElementById("theme-icon"),
  btnBrandHome: document.getElementById("btn-brand-home"),
  btnFooterHome: document.getElementById("btn-footer-home"),

  screenHome: document.getElementById("screen-home"),
  btnHomeStart: document.getElementById("btn-home-start"),
  btnHomeStartSecondary: document.getElementById("btn-home-start-secondary"),
  btnSetupBack: document.getElementById("btn-setup-back"),
  setupBackLabel: document.getElementById("setup-back-label"),
  homeEyebrow: document.getElementById("home-eyebrow"),
  homeTitle: document.getElementById("home-title"),
  homeDescription: document.getElementById("home-description"),
  homeStartLabel: document.getElementById("home-start-label"),
  homeLearnLink: document.getElementById("home-learn-link"),
  homeProofVoices: document.getElementById("home-proof-voices"),
  homeProofLanguages: document.getElementById("home-proof-languages"),
  homeProofGuests: document.getElementById("home-proof-guests"),
  homeProgressTitle: document.getElementById("home-progress-title"),
  homeLevelValue: document.getElementById("home-level-value"),
  homeTitleValue: document.getElementById("home-title-value"),
  homeTablesValue: document.getElementById("home-tables-value"),
  homeTablesLabel: document.getElementById("home-tables-label"),
  homeAccuracyValue: document.getElementById("home-accuracy-value"),
  homeAccuracyLabel: document.getElementById("home-accuracy-label"),
  homeProgressFill: document.getElementById("home-progress-fill"),
  homeProgressCaption: document.getElementById("home-progress-caption"),
  homeHowKicker: document.getElementById("home-how-kicker"),
  homeHowTitle: document.getElementById("home-how-title"),
  homeHowDescription: document.getElementById("home-how-description"),
  homeStep1Title: document.getElementById("home-step1-title"), homeStep1Text: document.getElementById("home-step1-text"),
  homeStep2Title: document.getElementById("home-step2-title"), homeStep2Text: document.getElementById("home-step2-text"),
  homeStep3Title: document.getElementById("home-step3-title"), homeStep3Text: document.getElementById("home-step3-text"),
  homeFeature1Title: document.getElementById("home-feature1-title"), homeFeature1Text: document.getElementById("home-feature1-text"),
  homeFeature2Title: document.getElementById("home-feature2-title"), homeFeature2Text: document.getElementById("home-feature2-text"),
  homeFeature3Title: document.getElementById("home-feature3-title"), homeFeature3Text: document.getElementById("home-feature3-text"),
  homeFinalTitle: document.getElementById("home-final-title"), homeFinalText: document.getElementById("home-final-text"),
  homeFinalButton: document.getElementById("home-final-button"),

  screenSetup: document.getElementById("screen-setup"),
  screenGame: document.getElementById("screen-game"),

  screenMenuBuilder: document.getElementById("screen-menu-builder"),
  menuBuilderTitle: document.getElementById("menu-builder-title"),
  menuBuilderHint: document.getElementById("menu-builder-hint"),
  menuBuilderContent: document.getElementById("menu-builder-content"),
  btnMenuBack: document.getElementById("btn-menu-back"),
  btnMenuConfirm: document.getElementById("btn-menu-confirm"),

  menuPanel: document.getElementById("menu-panel"),
  menuDetails: document.getElementById("menu-details"),
  menuTitle: document.getElementById("menu-title"),
  menuContent: document.getElementById("menu-content"),
  modeBanner: document.getElementById("mode-banner"),

  screenOrder: document.getElementById("screen-order"),
  orderTitle: document.getElementById("order-title"),
  orderProgress: document.getElementById("order-progress"),
  tableView: document.getElementById("table-view"),
  bonecoAvatar: document.getElementById("boneco-avatar"),
  bonecoName: document.getElementById("boneco-name"),
  bonecoStatus: document.getElementById("boneco-status"),
  bonecoText: document.getElementById("boneco-text"),
  btnListen: document.getElementById("btn-listen"),
  btnReveal: document.getElementById("btn-reveal"),
  btnNext: document.getElementById("btn-next"),
  btnExitTable: document.getElementById("btn-exit-table"),
  btnExitTableLabel: document.getElementById("btn-exit-table-label"),
  exitConfirm: document.getElementById("exit-confirm"),
  exitConfirmText: document.getElementById("exit-confirm-text"),
  btnExitCancel: document.getElementById("btn-exit-cancel"),
  btnExitLeave: document.getElementById("btn-exit-leave"),

  screenRegister: document.getElementById("screen-register"),
  registerTitle: document.getElementById("register-title"),
  registerHint: document.getElementById("register-hint"),
  registerList: document.getElementById("register-list"),
  btnConfirmOrder: document.getElementById("btn-confirm-order"),

  screenRecap: document.getElementById("screen-recap"),
  recapTitle: document.getElementById("recap-title"),
  recapHint: document.getElementById("recap-hint"),
  recapList: document.getElementById("recap-list"),
  btnRecapEdit: document.getElementById("btn-recap-edit"),
  btnRecapConfirm: document.getElementById("btn-recap-confirm"),

  screenResults: document.getElementById("screen-results"),
  resultsTitle: document.getElementById("results-title"),
  resultsScore: document.getElementById("results-score"),
  resultsCareer: document.getElementById("results-career"),
  resultsXp: document.getElementById("results-xp"),
  resultsList: document.getElementById("results-list"),
  btnNewTable: document.getElementById("btn-new-table"),

  playerSummary: document.getElementById("player-summary"),
  playerLevel: document.getElementById("player-level"),
  playerTitle: document.getElementById("player-title"),

  navTraining: document.getElementById("nav-training"),
  navCareer: document.getElementById("nav-career"),
  navDashboard: document.getElementById("nav-dashboard"),
  viewTraining: document.getElementById("view-training"),
  viewCareer: document.getElementById("view-career"),
  viewDashboard: document.getElementById("view-dashboard"),

  careerTitle: document.getElementById("career-title"),
  careerSubtitle: document.getElementById("career-subtitle"),
  careerProgress: document.getElementById("career-progress"),
  careerLangLabel: document.getElementById("career-lang-label"),
  careerLang: document.getElementById("career-lang"),
  careerGrid: document.getElementById("career-grid"),

  dashboardTitle: document.getElementById("dashboard-title"),
  dashboardSubtitle: document.getElementById("dashboard-subtitle"),
  btnDashboardStart: document.getElementById("btn-dashboard-start"),
  dashboardStartLabel: document.getElementById("dashboard-start-label"),
  dashboardStats: document.getElementById("dashboard-stats"),
  progressionCard: document.getElementById("progression-card"),
  progressionTitle: document.getElementById("progression-title"),
  btnResetProgress: document.getElementById("btn-reset-progress"),
  memoryStrengthTitle: document.getElementById("memory-strength-title"),
  memoryStrengthBars: document.getElementById("memory-strength-bars"),
  recentActivityTitle: document.getElementById("recent-activity-title"),
  recentActivityList: document.getElementById("recent-activity-list"),
  badgesTitle: document.getElementById("badges-title"),
  badgesGrid: document.getElementById("badges-grid"),
  performanceTrendTitle: document.getElementById("performance-trend-title"),
  performanceTrend: document.getElementById("performance-trend"),
  performanceInsightsTitle: document.getElementById("performance-insights-title"),
  performanceInsights: document.getElementById("performance-insights"),
  languageStatsTitle: document.getElementById("language-stats-title"),
  languageStats: document.getElementById("language-stats"),
  difficultyStatsTitle: document.getElementById("difficulty-stats-title"),
  difficultyStats: document.getElementById("difficulty-stats"),
};

// Pushes the current language's copy into every "static" piece of UI: the
// setup screen, the navbar, the footer, and the Dashboard's fixed labels.
// Called whenever the language changes, and once at startup. Screens that
// only exist while a table is active (order/register/recap/results/menu
// builder) set their own text inside their own render*() function instead,
// since they need to rebuild their content anyway.
function applySetupUIText() {
  const s = t();
  els.appTitle.textContent = s.appTitle;
  els.appSubtitle.textContent = s.appSubtitle;
  els.labelLang.textContent = s.setupLang;
  els.labelPeople.textContent = s.setupPeople;
  els.labelRecap.textContent = s.setupRecap;
  els.recapHelp.textContent = s.recapHelp;
  els.labelDifficulty.textContent = s.difficultyLabel;
  ["Beginner", "Normal", "Hard", "Expert"].forEach((key, i) => {
    els.inputDifficulty.options[i].textContent = s[`difficulty${key}`];
  });
  els.difficultyHelp.textContent = s[`difficultyHelp${els.inputDifficulty.value[0].toUpperCase()}${els.inputDifficulty.value.slice(1)}`];
  els.labelSimilarOrders.textContent = s.similarOrdersLabel;
  els.similarOrdersHelp.textContent = s.similarOrdersHelp;
  els.labelRushHour.textContent = s.rushHourLabel;
  els.rushHourHelp.textContent = s.rushHourHelp;
  els.labelMenuMode.textContent = s.menuModeLabel;
  els.inputMenuMode.options[0].textContent = s.menuModeRandom;
  els.inputMenuMode.options[1].textContent = s.menuModeCustom;
  els.labelOrderStyle.textContent = s.orderStyleLabel;
  els.inputOrderStyle.options[0].textContent = s.orderStyleRandom;
  els.inputOrderStyle.options[1].textContent = s.orderStyleFull;
  els.inputOrderStyle.options[2].textContent = s.orderStyleByCourse;
  els.labelTrainingFocus.textContent = s.trainingFocusLabel;
  els.inputTrainingFocus.options[0].textContent = s.trainingFocusComplete;
  els.inputTrainingFocus.options[1].textContent = s.trainingFocusDrinks;
  els.inputTrainingFocus.options[2].textContent = s.trainingFocusStarters;
  els.inputTrainingFocus.options[3].textContent = s.trainingFocusMains;
  els.welcomeText.textContent = s.welcomeText;
  els.footerCredit.textContent = s.footerCredit;
  els.footerTitle.textContent = s.appTitle;
  els.footerTagline.textContent = s.footerTagline;
  els.btnMute.title = state.muted ? s.unmuteLabel : s.muteLabel;
  els.btnTheme.title = document.documentElement.dataset.theme === "dark" ? s.themeLight : s.themeDark;
  els.btnTheme.setAttribute("aria-label", els.btnTheme.title);
  els.btnBrandHome.setAttribute("aria-label", s.brandHomeLabel);
  els.btnFooterHome.setAttribute("aria-label", s.brandHomeLabel);
  els.homeEyebrow.textContent = s.homeEyebrow;
  els.homeTitle.textContent = s.homeTitle;
  els.homeDescription.textContent = s.homeDescription;
  els.homeStartLabel.textContent = s.homeStart;
  els.homeLearnLink.textContent = s.homeLearn;
  els.homeProofVoices.textContent = s.homeProofVoices;
  els.homeProofLanguages.textContent = s.homeProofLanguages;
  els.homeProofGuests.textContent = s.homeProofGuests;
  els.homeProgressTitle.textContent = s.homeProgressTitle;
  els.homeTablesLabel.textContent = s.homeTables;
  els.homeAccuracyLabel.textContent = s.homeAccuracy;
  els.homeHowKicker.textContent = s.homeHowKicker;
  els.homeHowTitle.textContent = s.homeHowTitle;
  els.homeHowDescription.textContent = s.homeHowDescription;
  [1, 2, 3].forEach((n) => {
    els[`homeStep${n}Title`].textContent = s[`homeStep${n}Title`];
    els[`homeStep${n}Text`].textContent = s[`homeStep${n}Text`];
    els[`homeFeature${n}Title`].textContent = s[`homeFeature${n}Title`];
    els[`homeFeature${n}Text`].textContent = s[`homeFeature${n}Text`];
  });
  els.homeFinalTitle.textContent = s.homeFinalTitle;
  els.homeFinalText.textContent = s.homeFinalText;
  els.homeFinalButton.textContent = s.homeFinalButton;
  els.setupBackLabel.textContent = s.setupBack;
  els.btnStart.textContent = s.startButton;
  els.navTraining.textContent = s.navTraining;
  els.navCareer.textContent = s.navCareer;
  els.navDashboard.textContent = s.navDashboard;
  els.dashboardTitle.textContent = s.dashboardTitle;
  els.dashboardSubtitle.textContent = s.dashboardSubtitle;
  els.dashboardStartLabel.textContent = s.startTrainingCta;
  els.memoryStrengthTitle.textContent = s.sectionMemoryStrength;
  els.recentActivityTitle.textContent = s.sectionRecentActivity;
  els.badgesTitle.textContent = s.sectionBadges;
  els.performanceTrendTitle.textContent = s.sectionPerformanceTrend;
  els.performanceInsightsTitle.textContent = s.sectionPerformanceInsights;
  els.languageStatsTitle.textContent = s.sectionLanguageStats;
  els.difficultyStatsTitle.textContent = s.sectionDifficultyStats;
  els.progressionTitle.textContent = s.progressionTitle;
  els.btnResetProgress.textContent = s.resetProgress;
  els.careerTitle.textContent = s.careerTitle;
  els.careerSubtitle.textContent = s.careerSubtitle;
  els.careerLangLabel.textContent = s.careerLanguage;
  els.careerLang.value = state.lang;
  document.title = `${s.appTitle} — Waiter Memory Game`;
  updatePlayerSummary();
  renderHomeProgress();
}

function renderHomeProgress() {
  const s = t();
  const profile = loadProfile();
  const level = levelForXP(profile.totalXp);
  const history = loadHistory();
  const average = history.length ? Math.round(history.reduce((sum, item) => sum + (Number(item.pct) || 0), 0) / history.length) : null;
  els.homeLevelValue.textContent = s.levelShort(level.level);
  els.homeTitleValue.textContent = s[level.titleKey];
  els.homeTablesValue.textContent = history.length;
  els.homeAccuracyValue.textContent = average === null ? "—" : `${average}%`;
  els.homeProgressFill.style.width = `${level.progress}%`;
  els.homeProgressCaption.textContent = level.next ? s.homeProgressNext(level.next.xp - profile.totalXp, level.next.level) : s.homeProgressMax;
}

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeIcon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
  els.btnTheme.title = theme === "dark" ? t().themeLight : t().themeDark;
  els.btnTheme.setAttribute("aria-label", els.btnTheme.title);
}

els.btnTheme.addEventListener("click", () => {
  const theme = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(theme);
  try { localStorage.setItem("mesaCheia.theme", theme); } catch (e) { /* ignore */ }
});

els.inputDifficulty.addEventListener("change", applySetupUIText);

function updatePlayerSummary(profile = loadProfile()) {
  const s = t();
  const level = levelForXP(profile.totalXp);
  els.playerLevel.textContent = s.levelShort(level.level);
  els.playerTitle.textContent = s[level.titleKey];
  els.playerSummary.title = `${profile.totalXp} XP`;
}

els.inputLang.addEventListener("change", () => {
  state.lang = els.inputLang.value;
  els.careerLang.value = state.lang;
  applySetupUIText();
});

els.careerLang.addEventListener("change", () => {
  state.lang = els.careerLang.value;
  els.inputLang.value = state.lang;
  applySetupUIText();
  renderCareer();
});

// Syncs the mute button's icon/tooltip with state.muted.
function updateMuteIcon() {
  els.muteIcon.textContent = state.muted ? "volume_off" : "volume_up";
  els.btnMute.title = state.muted ? t().unmuteLabel : t().muteLabel;
}

els.btnMute.addEventListener("click", () => {
  state.muted = !state.muted;
  try {
    localStorage.setItem("mesaCheia.muted", String(state.muted));
  } catch (e) {
    /* ignore */
  }
  if (state.muted) stopAudio();
  updateMuteIcon();
});

applySetupUIText();
updateMuteIcon();
applyTheme(currentTheme());

function showHome() {
  stopAudio();
  stopTableTimer();
  els.screenHome.classList.remove("hidden");
  els.screenSetup.classList.add("hidden");
  els.screenMenuBuilder.classList.add("hidden");
  els.screenGame.classList.add("hidden");
  renderHomeProgress();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function showSetup() {
  stopAudio();
  els.screenHome.classList.add("hidden");
  els.screenSetup.classList.remove("hidden");
  els.screenMenuBuilder.classList.add("hidden");
  els.screenGame.classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

els.btnHomeStart.addEventListener("click", showSetup);
els.btnHomeStartSecondary.addEventListener("click", showSetup);
els.btnSetupBack.addEventListener("click", showHome);
function goToIntroduction() {
  setActiveView("training");
  showHome();
}
els.btnBrandHome.addEventListener("click", goToIntroduction);
els.btnFooterHome.addEventListener("click", goToIntroduction);

// Picks which greeting clip/text fits right now, by the visitor's local
// clock: mornings before noon, afternoons until 7pm, evenings after that.
function getGreetingClip() {
  const hour = new Date().getHours();
  if (hour < 12) return GREETING_CLIPS.morning;
  if (hour < 19) return GREETING_CLIPS.afternoon;
  return GREETING_CLIPS.evening;
}

// Text counterpart of getGreetingClip(), for the "reveal text" feature and
// for building the "full order" sentence passed to SPEECH_TEMPLATES.
function greetingText(lang) {
  const hour = new Date().getHours();
  const period = hour < 12 ? "morning" : hour < 19 ? "afternoon" : "evening";
  return GREETING_TEXT[lang][period];
}

// Resolves the profile stored on a guest. Older resumed sessions have no
// voiceId, so a stable profile is derived from the guest id as a fallback.
function getVoiceProfile(person, lang) {
  const profiles = VOICE_PROFILES[lang];
  return profiles.find((profile) => profile.id === person.voiceId)
    || profiles[hashString(`${lang}:${person.id}`) % profiles.length];
}

// Builds both a preferred profile-specific source and the legacy fallback
// for a clip. Profile folders can therefore be added one voice at a time
// without changing the game engine or breaking incomplete voice packs.
function audioClipSources(clipName, lang, voiceProfile) {
  const fallback = `${AUDIO_BASE}/${lang}/${clipName}.m4a`;
  const extension = voiceProfile.format || "m4a";
  return {
    primary: voiceProfile.recorded
      ? `${AUDIO_BASE}/${lang}/${voiceProfile.folder}/${clipName}.${extension}`
      : fallback,
    fallback,
  };
}

// Turns a SPEECH_SEGMENTS entry (see data.js) into an ordered list of audio
// sources for one guest's queue step: connector clips are used as-is, a
// `{ field }` segment resolves to that guest's chosen dish's own clip, and
// `{ greeting: true }` resolves to whichever GREETING_CLIPS fits right now.
function buildAudioPlaylist(person, type, lang) {
  const voiceProfile = getVoiceProfile(person, lang);
  const segments = SPEECH_SEGMENTS[lang][type];
  return segments.map((seg, index) => {
    const clipName = seg.greeting ? getGreetingClip() : seg.clip || person.order[seg.field];
    const next = segments[index + 1];
    const sentenceBreak = seg.greeting
      || seg.clip === "conn_drink_outro"
      || (seg.field && ["conn_principal_intro", "conn_sobremesa_intro"].includes(next?.clip));
    return {
      ...audioClipSources(clipName, lang, voiceProfile),
      // Tiny joins inside a phrase; a natural breath only between courses.
      // A small breath between courses; a slight overlap inside phrases
      // joins Azure's independently generated words without an audible cut.
      pauseAfter: sentenceBreak ? 0.05 : -0.032,
    };
  });
}

// Web Audio decodes every fragment before speech begins, trims the silence
// Azure leaves at clip edges and schedules the whole sentence on one clock.
// This prevents network/decode time from becoming an audible pause between
// words. The HTMLAudioElement player below remains as a compatibility fallback.
let audioPlayer = null;
let playToken = 0;
let audioContext = null;
let tableTimer = null;
const audioBufferCache = new Map();
const scheduledSources = new Set();

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext) audioContext = new AudioContextClass();
  return audioContext;
}

function decodeClip(url, context) {
  if (!audioBufferCache.has(url)) {
    audioBufferCache.set(url, fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`Audio ${response.status}: ${url}`);
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .catch((error) => {
        audioBufferCache.delete(url);
        throw error;
      }));
  }
  return audioBufferCache.get(url);
}

async function loadClipBuffer(clip, context) {
  try {
    return await decodeClip(clip.primary, context);
  } catch (error) {
    if (clip.fallback && clip.fallback !== clip.primary) {
      return decodeClip(clip.fallback, context);
    }
    throw error;
  }
}

// Finds the first and last audible samples and keeps a very small margin.
// We schedule that range directly, so no rewritten audio files are needed.
function audibleRange(buffer) {
  const threshold = 0.006;
  const margin = Math.floor(buffer.sampleRate * 0.006);
  let first = 0;
  let last = buffer.length - 1;
  const audibleAt = (sample) => {
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      if (Math.abs(buffer.getChannelData(channel)[sample]) >= threshold) return true;
    }
    return false;
  };
  while (first < buffer.length && !audibleAt(first)) first++;
  while (last > first && !audibleAt(last)) last--;
  if (first >= buffer.length) return { offset: 0, duration: buffer.duration };
  first = Math.max(0, first - margin);
  last = Math.min(buffer.length - 1, last + margin);
  return { offset: first / buffer.sampleRate, duration: Math.max(0.03, (last - first + 1) / buffer.sampleRate) };
}

// Stops whatever is currently playing (if anything) and invalidates any
// in-flight clip chain from a previous playClips() call.
function stopAudio() {
  playToken++;
  scheduledSources.forEach((source) => {
    try { source.stop(); } catch (e) { /* already stopped */ }
  });
  scheduledSources.clear();
  if (audioPlayer) {
    audioPlayer.pause();
  }
}

function stopTableTimer() {
  if (tableTimer) clearInterval(tableTimer);
  tableTimer = null;
}

function formatClock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateOrderProgress() {
  if (!state.table) return;
  const table = state.table;
  const base = `${Math.min(table.queueIndex + 1, table.queue.length)} / ${table.queue.length}`;
  if (!table.maxSeconds || !table.startedAt) { els.orderProgress.textContent = base; return; }
  const remaining = Math.max(0, table.maxSeconds - Math.floor((Date.now() - table.startedAt) / 1000));
  els.orderProgress.textContent = `${base} · ${t().rushTime(formatClock(remaining))}`;
  if (remaining === 0 && !table.timeExpired) {
    table.timeExpired = true;
    stopAudio();
    stopTableTimer();
    window.setTimeout(() => { window.alert(t().timeExpired); renderRegisterScreen(); }, 0);
  }
}

function startTableTimer() {
  stopTableTimer();
  if (!state.table?.maxSeconds) return;
  updateOrderProgress();
  tableTimer = window.setInterval(updateOrderProgress, 1000);
}

// Compatibility path for browsers without Web Audio or when decoding fails.
// It deliberately has no artificial delay; the files' own punctuation still
// provides natural sentence boundaries.
function playClipsLegacy(clips, voiceProfile, myToken) {
  if (!audioPlayer) audioPlayer = new Audio();
  audioPlayer.playbackRate = voiceProfile.playbackRate;
  audioPlayer.preservesPitch = true;

  let i = 0;
  let triedFallback = false;
  const playNext = () => {
    if (myToken !== playToken || i >= clips.length) return;
    const clip = clips[i];
    triedFallback = clip.primary === clip.fallback;
    audioPlayer.src = clip.primary;
    i++;
    audioPlayer.play().catch(() => {
      /* ignore — e.g. a stricter autoplay policy on a call not triggered
         by direct user interaction; the player just stays silent */
    });
  };
  audioPlayer.onended = () => {
    if (myToken === playToken) playNext();
  };
  audioPlayer.onerror = () => {
    if (myToken !== playToken) return;
    const failedClip = clips[i - 1];
    if (!triedFallback && failedClip && failedClip.fallback) {
      triedFallback = true;
      audioPlayer.src = failedClip.fallback;
      audioPlayer.play().catch(() => playNext());
      return;
    }
    // Skip a failed legacy clip rather than breaking the whole sequence.
    playNext();
  };
  playNext();
}

// Preloads all fragments in parallel and schedules a gapless sentence.
async function playClips(clips, voiceProfile) {
  stopAudio();
  if (state.muted || clips.length === 0) return;
  const myToken = playToken;
  const context = getAudioContext();
  if (!context) {
    playClipsLegacy(clips, voiceProfile, myToken);
    return;
  }

  try {
    if (context.state === "suspended") await context.resume();
    const buffers = await Promise.all(clips.map((clip) => loadClipBuffer(clip, context)));
    if (myToken !== playToken || state.muted) return;

    const rate = voiceProfile.playbackRate || 1;
    let startAt = context.currentTime + 0.045;
    buffers.forEach((buffer, index) => {
      const range = audibleRange(buffer);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.connect(context.destination);
      scheduledSources.add(source);
      source.onended = () => scheduledSources.delete(source);
      source.start(startAt, range.offset, range.duration);
      startAt += range.duration / rate + (clips[index].pauseAfter ?? -0.032);
    });
  } catch (error) {
    if (myToken === playToken && !state.muted) playClipsLegacy(clips, voiceProfile, myToken);
  }
}

// Speaks a guest's line for the given queue step type by playing the
// matching sequence of pre-recorded clips (see SPEECH_SEGMENTS in data.js).
function speakOrder(person, type, lang) {
  playClips(buildAudioPlaylist(person, type, lang), getVoiceProfile(person, lang));
}

// Builds a brand-new table: picks (or accepts a hand-picked) menu, creates
// `peopleCount` guests each with a random dish per course from that menu,
// and lays out the order in which the waiter will hear from them.
//   - customMenu: pass a menu object (from the menu builder) to use it as-is
//     instead of picking a random subset of MENU_POOL.
//   - orderStyle: "full" (each guest states everything at once), "byCourse"
//     (drinks, then starters, then mains, then desserts, across all guests),
//     or anything else for a 50/50 random pick between the two each table.
// `completed` tracks, per guest, which course fields have already been
// "heard" — used to light up progress dots on the seating chart.
function buildTable(lang, peopleCount, recapEnabled, customMenu, orderStyle, trainingFocus = "complete", difficulty = "normal", similarOrders = false, rushHour = false) {
  const difficultyConfig = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
  const size = difficultyConfig.menuSize;
  const menu = customMenu || {
    entrada: pickRandom(MENU_POOL.entrada, size),
    principal: pickRandom(MENU_POOL.principal, size),
    acompanhamento: pickRandom(MENU_POOL.acompanhamento, Math.max(3, size - 1)),
    sobremesa: pickRandom(MENU_POOL.sobremesa, Math.max(3, size - 1)),
    bebida: pickRandom(MENU_POOL.bebida, size),
  };

  const namesByGender = {
    f: shuffle(GUEST_NAMES[lang].filter((guest) => guest.g === "f")),
    m: shuffle(GUEST_NAMES[lang].filter((guest) => guest.g === "m")),
  };
  // Pick portraits first so a full 10-person table always contains ten
  // distinct faces. Names are then selected from the matching gender pool.
  const guestProfiles = shuffle([
    ...AVATARS.f.map((avatar) => ({ avatar, g: "f", avatarIndex: Number(avatar.match(/avatar(\d+)/)?.[1]) })),
    ...AVATARS.m.map((avatar) => ({ avatar, g: "m", avatarIndex: Number(avatar.match(/avatar(\d+)/)?.[1]) })),
  ]);
  const nameIndexes = { f: 0, m: 0 };
  const people = [];
  const completed = {};
  for (let i = 0; i < peopleCount; i++) {
    const profile = guestProfiles[i % guestProfiles.length];
    const genderNames = namesByGender[profile.g];
    const nameIndex = nameIndexes[profile.g]++;
    const guest = genderNames[nameIndex % genderNames.length];
    const voiceProfile = VOICE_PROFILES[lang].find((voice) => voice.avatarIndex === profile.avatarIndex)
      || VOICE_PROFILES[lang][i % VOICE_PROFILES[lang].length];
    const name = guest.name + (nameIndex >= genderNames.length ? ` ${Math.floor(nameIndex / genderNames.length) + 1}` : "");
    const id = `person_${i}`;
    people.push({
      id,
      name,
      seat: i + 1,
      avatar: profile.avatar,
      gender: profile.g,
      voiceId: voiceProfile.id,
      order: similarOrders ? {
        entrada: menu.entrada[Math.floor(i / 2) % Math.min(3, menu.entrada.length)].id,
        principal: menu.principal[Math.floor(i / 2) % Math.min(3, menu.principal.length)].id,
        acompanhamento: menu.acompanhamento[(Math.floor(i / 2) + (i % 2)) % Math.min(4, menu.acompanhamento.length)].id,
        sobremesa: menu.sobremesa[Math.floor(i / 2) % Math.min(3, menu.sobremesa.length)].id,
        bebida: menu.bebida[(Math.floor(i / 2) + (i % 2)) % Math.min(4, menu.bebida.length)].id,
      } : {
        entrada: pickRandom(menu.entrada, 1)[0].id,
        principal: pickRandom(menu.principal, 1)[0].id,
        acompanhamento: pickRandom(menu.acompanhamento, 1)[0].id,
        sobremesa: pickRandom(menu.sobremesa, 1)[0].id,
        bebida: pickRandom(menu.bebida, 1)[0].id,
      },
    });
    completed[id] = new Set();
  }

  let mode;
  if (orderStyle === "full") mode = "perPerson";
  else if (orderStyle === "byCourse") mode = "rounds";
  else mode = Math.random() < 0.5 ? "rounds" : "perPerson";
  const activeFields = TRAINING_FOCUS[trainingFocus] || TRAINING_FOCUS.complete;
  const queue = buildQueue(people, mode, activeFields);

  // `startedAt` is set once the player actually starts the queue (see
  // renderOrderStart's Start Service button) rather than here, so time
  // spent on the "ready?" gate doesn't count against the table's duration.
  return { lang, menu, people, mode, trainingFocus, activeFields, recapEnabled, difficulty, similarOrders, rushHour,
    maxSeconds: rushHour ? Math.max(90, peopleCount * 25) : null, queue, queueIndex: 0, completed, replayCounts: {}, started: false, startedAt: null };
}

// Marks the field(s) a queue step covered as "heard" for that guest, so the
// seating chart's progress dots reflect it. A "principalAcompanhamento" step
// covers two fields at once (they're always spoken together), and a "full"
// step covers all of them.
function markStepDone(table, step) {
  const set = table.completed[step.personId];
  if (step.type === "full") {
    ["bebida", "entrada", "principal", "acompanhamento", "sobremesa"].forEach((f) => set.add(f));
  } else if (step.type === "principalAcompanhamento") {
    set.add("principal");
    set.add("acompanhamento");
  } else {
    set.add(step.type);
  }
}

// Builds the ordered list of "who speaks what, next" steps that
// renderOrderStep() walks through one at a time.
//   - "rounds" mode: one pass per course (drinks, starters, mains+sides,
//     desserts), each pass visiting every guest in a fresh random order —
//     i.e. a realistic "take all the drink orders, then all the starters...".
//   - any other mode: each guest gets a single "full" step where they state
//     their entire order at once, guests visited in random order.
function buildQueue(people, mode, activeFields = TRAINING_FOCUS.complete) {
  const fields = [];
  if (activeFields.includes("bebida")) fields.push("bebida");
  if (activeFields.includes("entrada")) fields.push("entrada");
  if (activeFields.includes("principal") || activeFields.includes("acompanhamento")) fields.push("principalAcompanhamento");
  if (activeFields.includes("sobremesa")) fields.push("sobremesa");
  const isComplete = activeFields.length === TRAINING_FOCUS.complete.length;
  if (mode === "rounds" || !isComplete) {
    const queue = [];
    if (mode === "rounds") {
      for (const field of fields) for (const p of shuffle(people)) queue.push({ personId: p.id, type: field });
    } else {
      for (const p of shuffle(people)) for (const field of fields) queue.push({ personId: p.id, type: field });
    }
    return queue;
  }
  return shuffle(people).map((p) => ({ personId: p.id, type: "full" }));
}

// Renders the sentence a guest "says" for a given queue step type, by
// looking up their chosen dish names in `lang` and feeding them into the
// matching SPEECH_TEMPLATES function.
function getSpeechText(person, type, lang) {
  const o = person.order;
  const names = {
    entrada: itemName(o.entrada, lang),
    principal: itemName(o.principal, lang),
    acompanhamento: itemName(o.acompanhamento, lang),
    sobremesa: itemName(o.sobremesa, lang),
    bebida: itemName(o.bebida, lang),
  };
  const avatarIndex = Number(person.avatar?.match(/avatar(\d+)/)?.[1]) || 1;
  const tpl = SPEECH_VARIANTS[lang]?.[avatarIndex - 1] || SPEECH_TEMPLATES[lang];
  switch (type) {
    case "bebida": return tpl.bebida(names.bebida);
    case "entrada": return tpl.entrada(names.entrada);
    case "principalAcompanhamento": return tpl.principal(names.principal, names.acompanhamento);
    case "sobremesa": return tpl.sobremesa(names.sobremesa);
    case "full": return tpl.full(names, greetingText(lang));
  }
}

// Fills the sidebar "Today's Menu" panel from the active table's menu.
// Also decides whether the panel starts expanded or collapsed: expanded on
// desktop-sized viewports, collapsed on narrow/mobile ones (it's a native
// <details> element, so the player can still toggle it either way by tapping
// the summary).
function renderMenuPanel() {
  const s = t();
  const { menu, activeFields = TRAINING_FOCUS.complete } = state.table;
  els.menuTitle.textContent = s.menuTitle;
  const cats = [
    ["entrada", s.catEntrada],
    ["principal", s.catPrincipal],
    ["acompanhamento", s.catAcompanhamento],
    ["sobremesa", s.catSobremesa],
    ["bebida", s.catBebida],
  ];
  els.menuContent.innerHTML = cats
    .filter(([key]) => activeFields.includes(key))
    .map(([key, label]) => {
      const items = menu[key].map((item) => `<li>${item[state.lang]}</li>`).join("");
      return `<div class="menu-cat"><div class="menu-cat-head"><span class="material-symbols-outlined">${CATEGORY_ICONS[key]}</span><h3>${label}</h3></div><ul>${items}</ul></div>`;
    })
    .join("");
  els.menuDetails.open = window.innerWidth > 780;
}

// Shows the "Mode: ..." hint banner explaining which order-taking style
// this particular table ended up using.
function renderModeBanner() {
  const s = t();
  state.table.difficulty ||= "normal";
  const focusKey = `trainingFocus${state.table.trainingFocus === "complete" ? "Complete" : state.table.trainingFocus[0].toUpperCase() + state.table.trainingFocus.slice(1)}`;
  const focus = s[focusKey] || s.trainingFocusComplete;
  const difficulty = s[`difficulty${state.table.difficulty[0].toUpperCase()}${state.table.difficulty.slice(1)}`];
  const extras = [state.table.similarOrders ? s.similarOrdersLabel : "", state.table.rushHour ? "Rush Hour" : ""].filter(Boolean);
  els.modeBanner.textContent = `${focus} · ${difficulty} · ${state.table.mode === "rounds" ? s.modeRounds : s.modePerson}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

// Shows one of the four "in-game" screens (order/register/recap/results)
// and hides the other three. The setup and menu-builder screens are toggled
// separately by their own callers since they're mutually exclusive with the
// whole #screen-game section, not with each other.
//
// Also controls two shared elements that live outside the four panels:
//   - The seating chart (#table-view) stays visible for order/register/recap
//     — waiters rely on it to associate a guest's seat with their order —
//     and is only hidden once the table's results are shown.
//   - The "Today's Menu" sidebar is only useful while taking the order (to
//     remind the waiter what's on today's menu); it's redundant once
//     registering or recapping, where the choices are already the chips
//     on screen, so it's hidden for those two stages to give them more room.
function showStagePanel(name) {
  if (name !== "order") {
    stopAudio();
    stopTableTimer();
  }
  ["order", "register", "recap", "results"].forEach((n) => {
    document.getElementById(`screen-${n}`).classList.toggle("hidden", n !== name);
  });
  els.tableView.classList.toggle("hidden", name === "results");
  els.menuPanel.classList.toggle("hidden", name === "register" || name === "recap");
}

// Renders the animated seating chart: every guest placed evenly around an
// ellipse (in percentage coordinates, so it scales with the container),
// with the currently-speaking guest highlighted and given a speech bubble.
// The small dots under each guest reflect `completed` (see markStepDone) —
// a purely visual "who's already told us what" progress indicator.
function renderTableView(activePersonId) {
  const { people, completed, activeFields = TRAINING_FOCUS.complete } = state.table;
  const n = people.length;
  const cx = 50, cy = n >= 7 ? 46 : 48;
  // Pull the ellipse in a bit for very small tables so 1-2 seats don't sit
  // awkwardly far from the center.
  const rx = n <= 2 ? 30 : n >= 7 ? 39 : 42;
  const ry = n >= 7 ? 30 : n <= 2 ? 29 : 33;

  els.tableView.className = `table-count-${Math.min(n, 10)}`;

  const seats = people.map((p, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const x = cx + rx * Math.cos(angle);
    const y = cy + ry * Math.sin(angle);
    const isActive = p.id === activePersonId;
    const done = completed[p.id];
    const dots = ["bebida", "entrada", "principal", "sobremesa"].filter((f) => activeFields.includes(f))
      .map((f) => `<span class="dot ${done.has(f) ? "done" : ""}"></span>`)
      .join("");
    return `
      <div class="seat ${isActive ? "active" : ""}" style="left:${x}%; top:${y}%;">
        ${isActive ? '<div class="speech-bubble">&hellip;</div>' : ""}
        <div class="avatar-circle">${avatarMarkup(p)}</div>
        <div class="seat-name">${p.name}</div>
        <div class="seat-number">#${String(p.seat || i + 1).padStart(2, "0")}</div>
        <div class="progress-dots">${dots}</div>
      </div>`;
  }).join("");

  els.tableView.innerHTML = `<div id="table-surface"></div>${seats}`;
}

// Wires the Exit button + its confirmation card. Shared by renderOrderStart
// (the pre-service gate below) and renderOrderStep (every in-progress
// step), since both live on the order screen and offer the same "leave
// without saving" escape hatch.
function wireExitButton() {
  const s = t();
  els.btnExitTableLabel.textContent = s.exitTable;
  els.exitConfirmText.textContent = s.exitConfirmMsg;
  els.btnExitCancel.textContent = s.exitCancel;
  els.btnExitLeave.textContent = s.exitLeave;
  els.exitConfirm.classList.add("hidden");
  els.btnExitTable.onclick = () => els.exitConfirm.classList.remove("hidden");
  els.btnExitCancel.onclick = () => els.exitConfirm.classList.add("hidden");
  els.btnExitLeave.onclick = () => {
    stopAudio();
    stopTableTimer();
    clearSession();
    state.table = null;
    state.registered = {};
    els.screenGame.classList.add("hidden");
    els.screenSetup.classList.remove("hidden");
    applySetupUIText();
  };
}

// One-time "ready?" gate shown right after a table is created, before any
// guest has said a word — clicking straight from "New Table" into a guest
// already mid-sentence felt jarring in practice. The seating chart is shown
// (with nobody highlighted yet) so the waiter can take in who's sitting
// where before service starts. Starting the queue is also when the table's
// elapsed-time clock begins (see buildTable's `startedAt` note), so time
// spent on this screen doesn't count against the "Agile Service" badge.
function renderOrderStart() {
  const s = t();
  showStagePanel("order");
  renderTableView(null);
  els.orderTitle.textContent = s.orderTitle;
  els.orderProgress.textContent = `0 / ${state.table.queue.length}`;
  els.bonecoAvatar.innerHTML = "";
  els.bonecoAvatar.classList.add("hidden");
  els.bonecoName.textContent = "";
  els.bonecoStatus.textContent = s.readyMsg;
  els.bonecoText.textContent = "";
  els.bonecoText.classList.add("hidden");
  els.btnListen.classList.add("hidden");
  els.btnReveal.classList.add("hidden");
  els.btnNext.classList.remove("hidden");
  els.btnNext.innerHTML = `<span class="material-symbols-outlined">play_arrow</span>${s.startServiceBtn}`;
  els.btnNext.onclick = () => {
    state.table.started = true;
    state.table.startedAt = Date.now();
    startTableTimer();
    renderOrderStep();
  };

  wireExitButton();
  persistSession("order");
}

// Renders the current step of the order-taking queue: which guest is
// "talking" right now, wires up Listen/Reveal/Next and the exit-table
// confirmation, speaks the line automatically, and snapshots the session
// for resume. Defers to renderOrderStart() until the player has explicitly
// started the queue, and to the register screen once it's exhausted.
function renderOrderStep() {
  const s = t();
  if (!state.table.started) {
    renderOrderStart();
    return;
  }
  const { queue, queueIndex, people, lang } = state.table;
  els.orderTitle.textContent = s.orderTitle;

  if (queueIndex >= queue.length) {
    renderRegisterScreen();
    return;
  }

  showStagePanel("order");
  const step = queue[queueIndex];
  const person = people.find((p) => p.id === step.personId);
  updateOrderProgress();
  renderTableView(person.id);
  els.bonecoAvatar.innerHTML = avatarMarkup(person);
  els.bonecoAvatar.classList.remove("hidden");
  els.bonecoName.textContent = person.name;
  els.bonecoStatus.textContent = s.askingFor(person.name) + ` (${s.fieldLabel[step.type]})`;
  els.bonecoText.textContent = "";
  els.bonecoText.classList.add("hidden");
  els.btnListen.classList.remove("hidden");
  els.btnReveal.classList.remove("hidden");
  els.btnListen.innerHTML = `<span class="material-symbols-outlined">hearing</span>${s.listen}`;
  els.btnReveal.innerHTML = `<span class="material-symbols-outlined">visibility</span>${s.reveal}`;
  els.btnReveal.dataset.revealed = "false";
  els.btnNext.innerHTML = `${s.next}<span class="material-symbols-outlined">arrow_forward</span>`;

  const text = getSpeechText(person, step.type, lang);
  const difficultyConfig = DIFFICULTIES[state.table.difficulty] || DIFFICULTIES.normal;
  const replayKey = `${queueIndex}:${person.id}`;
  const refreshReplayButton = () => {
    const used = state.table.replayCounts?.[replayKey] || 0;
    const disabled = Number.isFinite(difficultyConfig.maxReplays) && used >= difficultyConfig.maxReplays;
    els.btnListen.disabled = disabled;
    els.btnListen.title = disabled ? s.replayLimit : "";
  };
  els.btnListen.onclick = () => {
    state.table.replayCounts ||= {};
    state.table.replayCounts[replayKey] = (state.table.replayCounts[replayKey] || 0) + 1;
    speakOrder(person, step.type, lang);
    refreshReplayButton();
  };
  refreshReplayButton();
  els.btnReveal.classList.toggle("hidden", !difficultyConfig.allowReveal);
  els.btnReveal.onclick = () => {
    const revealed = els.btnReveal.dataset.revealed === "true";
    if (revealed) {
      els.bonecoText.classList.add("hidden");
      els.btnReveal.innerHTML = `<span class="material-symbols-outlined">visibility</span>${s.reveal}`;
      els.btnReveal.dataset.revealed = "false";
    } else {
      els.bonecoText.textContent = text;
      els.bonecoText.classList.remove("hidden");
      els.btnReveal.innerHTML = `<span class="material-symbols-outlined">visibility_off</span>${s.hide}`;
      els.btnReveal.dataset.revealed = "true";
    }
  };
  els.btnNext.onclick = () => {
    stopAudio();
    markStepDone(state.table, step);
    state.table.queueIndex++;
    renderOrderStep();
  };

  wireExitButton();
  persistSession("order");
  speakOrder(person, step.type, lang);
}

// Renders one category's worth of selectable "chip" buttons for a guest on
// the register screen (e.g. all the starters, as pill buttons). `selectedId`
// pre-selects a chip if the player is coming back to fix a previous answer
// (via the recap screen's "go back and fix").
function chipFieldHTML(person, key, catLabel, table, selectedId) {
  const chips = table.menu[key]
    .map((item) => {
      const active = item.id === selectedId ? "active" : "";
      return `<button type="button" class="chip ${active}" data-person="${person.id}" data-field="${key}" data-value="${item.id}">${item[state.lang]}</button>`;
    })
    .join("");
  return `
    <div class="chip-field">
      <div class="field-label"><span class="material-symbols-outlined">${CATEGORY_ICONS[key]}</span>${catLabel}</div>
      <div class="chip-group" data-person="${person.id}" data-field="${key}">${chips}</div>
    </div>`;
}

// The "register from memory" screen: one card per guest, with a row of
// chips per course. Chips behave like a single-select radio group within
// each course (clicking one deselects any sibling, clicking the already-
// active one deselects it) — wired up here rather than in chipFieldHTML
// since it needs to reach across all the chips just rendered. On confirm,
// reads whichever chip is `.active` per guest/course (or "" if none was
// picked) into state.registered, then moves on to the recap or results
// screen depending on the table's settings.
function renderRegisterScreen() {
  const s = t();
  showStagePanel("register");
  renderTableView(null);
  els.registerTitle.textContent = s.registerTitle;
  els.registerHint.textContent = s.registerHint;
  els.btnConfirmOrder.textContent = s.confirmOrder;

  const table = state.table;
  const previous = state.registered || {};
  const fieldLabels = { bebida: s.catBebida, entrada: s.catEntrada, principal: s.catPrincipal, acompanhamento: s.catAcompanhamento, sobremesa: s.catSobremesa };
  els.registerList.innerHTML = table.people
    .map((p) => {
      const sel = previous[p.id] || {};
      const fields = (table.activeFields || TRAINING_FOCUS.complete)
        .map((key) => chipFieldHTML(p, key, fieldLabels[key], table, sel[key]))
        .join("");
      return `
        <div class="person-card">
          ${personCardHeader(p)}
          ${fields}
        </div>`;
    })
    .join("");

  els.registerList.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const group = chip.parentElement;
      const wasActive = chip.classList.contains("active");
      group.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      if (!wasActive) chip.classList.add("active");
    });
  });

  els.btnConfirmOrder.onclick = () => {
    const registered = {};
    table.people.forEach((p) => {
      registered[p.id] = {};
      (table.activeFields || TRAINING_FOCUS.complete).forEach((key) => {
        registered[p.id][key] = els.registerList.querySelector(`.chip-group[data-person="${p.id}"][data-field="${key}"] .chip.active`)?.dataset.value || "";
      });
    });
    state.registered = registered;
    if (table.recapEnabled) {
      renderRecapScreen();
    } else {
      renderResultsScreen();
    }
  };

  persistSession("register");
}

// Like itemName(), but tolerates an empty/undefined id (a course the player
// left unanswered) by showing an em dash instead of throwing.
function nameOrDash(id, lang) {
  return id ? itemName(id, lang) : "—";
}

// Optional "last call" screen: lets the player re-read everything they just
// registered for the table before locking it in, going back to fix an
// answer if something looks wrong. Only shown when the table was set up
// with `recapEnabled`.
function renderRecapScreen() {
  const s = t();
  showStagePanel("recap");
  renderTableView(null);
  els.recapTitle.textContent = s.recapTitle;
  els.recapHint.textContent = s.recapHint;
  els.btnRecapEdit.textContent = s.recapEdit;
  els.btnRecapConfirm.textContent = s.recapConfirm;

  const table = state.table;
  const recapLabels = { bebida: s.catBebida, entrada: s.catEntrada, principal: s.catPrincipal, acompanhamento: s.catAcompanhamento, sobremesa: s.catSobremesa };
  els.recapList.innerHTML = table.people
    .map((p) => {
      const r = state.registered[p.id];
      const lines = (table.activeFields || TRAINING_FOCUS.complete)
        .map((key) => `<div class="recap-line"><b>${recapLabels[key]}:</b> ${nameOrDash(r[key], state.lang)}</div>`)
        .join("");
      return `
        <div class="person-card">
          ${personCardHeader(p)}
          ${lines}
        </div>`;
    })
    .join("");

  els.btnRecapEdit.onclick = () => renderRegisterScreen();
  els.btnRecapConfirm.onclick = () => renderResultsScreen();

  persistSession("recap");
}

// Maps a score percentage to one of the four status labels shown under the
// results gauge (e.g. "MASTERED" vs "NEEDS PRACTICE").
function gaugeStatusLabel(s, pct) {
  if (pct >= 90) return s.gaugeDominated;
  if (pct >= 70) return s.gaugeGreat;
  if (pct >= 50) return s.gaugeProgress;
  return s.gaugePractice;
}

// Final screen for a table: compares what was registered against the truth
// (`p.order`) for every guest/course, renders a per-course correct/wrong
// breakdown plus an animated circular accuracy gauge, and — this is the
// only place a table's outcome is ever recorded — saves the session to the
// Dashboard's history. Clears the resumable session first, since a finished
// table has nothing left to resume.
function renderResultsScreen() {
  const s = t();
  clearSession();
  showStagePanel("results");
  els.resultsTitle.textContent = s.resultsTitle;

  const table = state.table;
  const fieldKeys = table.activeFields || TRAINING_FOCUS.complete;
  const fieldLabels = {
    bebida: s.catBebida,
    entrada: s.catEntrada,
    principal: s.catPrincipal,
    acompanhamento: s.catAcompanhamento,
    sobremesa: s.catSobremesa,
  };

  let correctCount = 0;
  let totalCount = 0;
  let currentCombo = 0;
  let maxCombo = 0;
  const byCategory = {};
  fieldKeys.forEach((k) => (byCategory[k] = { correct: 0, total: 0 }));

  const blocks = table.people.map((p) => {
    const truth = p.order;
    const reg = state.registered[p.id];
    const rows = fieldKeys
      .map((key) => {
        totalCount++;
        byCategory[key].total++;
        const ok = reg[key] === truth[key];
        if (ok) {
          correctCount++;
          byCategory[key].correct++;
          currentCombo++;
          maxCombo = Math.max(maxCombo, currentCombo);
        } else {
          currentCombo = 0;
        }
        const icon = ok ? "check_circle" : "cancel";
        const answers = ok
          ? `<span>${nameOrDash(truth[key], state.lang)}</span>`
          : `<span class="missed">${nameOrDash(reg[key], state.lang)}</span><span class="truth">${s.theyOrdered} ${nameOrDash(truth[key], state.lang)}</span>`;
        return `
          <div class="result-row ${ok ? "ok" : "bad"}">
            <div class="row-left">
              <span class="row-icon"><span class="material-symbols-outlined">${icon}</span></span>
              <span class="field-name">${fieldLabels[key]}</span>
            </div>
            <span class="answers">${answers}</span>
          </div>`;
      })
      .join("");
    return `
      <div class="person-card">
        ${personCardHeader(p)}
        ${rows}
      </div>`;
  });

  const pct = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const r = 80;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (circumference * pct) / 100;
  els.resultsScore.innerHTML = `
    <div class="gauge-wrap">
      <svg viewBox="0 0 176 176">
        <circle class="gauge-track" cx="88" cy="88" r="${r}" fill="transparent" stroke-width="10"></circle>
        <circle class="gauge-fill" cx="88" cy="88" r="${r}" fill="transparent" stroke-width="10" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"></circle>
      </svg>
      <div class="gauge-center">
        <span class="gauge-pct">${pct}%</span>
        <span class="gauge-status">${gaugeStatusLabel(s, pct)}</span>
      </div>
    </div>
    <p class="gauge-sub">${s.scoreLabel}: ${correctCount}/${totalCount}</p>`;
  requestAnimationFrame(() => {
    const fill = els.resultsScore.querySelector(".gauge-fill");
    if (fill) fill.style.strokeDashoffset = String(offset);
  });

  els.resultsList.innerHTML = blocks.join("");
  els.btnNewTable.textContent = table.careerMissionId ? s.careerContinue : s.newTable;
  els.btnNewTable.onclick = () => {
    stopAudio();
    stopTableTimer();
    els.screenGame.classList.add("hidden");
    els.screenSetup.classList.remove("hidden");
    applySetupUIText();
    if (table.careerMissionId) setActiveView("career");
  };

  const elapsedMs = table.startedAt ? Date.now() - table.startedAt : null;
  const careerResult = evaluateCareerMission(table, pct, elapsedMs);
  const resultRecord = {
    ts: Date.now(),
    correct: correctCount,
    total: totalCount,
    pct,
    peopleCount: table.people.length,
    mode: table.mode,
    elapsedMs,
    byCategory,
    maxCombo,
    careerMissionId: table.careerMissionId,
    lang: table.lang,
    difficulty: table.difficulty || "normal",
    similarOrders: Boolean(table.similarOrders),
    rushHour: Boolean(table.rushHour || table.maxSeconds),
    withinTime: !table.maxSeconds || elapsedMs <= table.maxSeconds * 1000,
    careerBonus: careerResult?.firstClear ? careerResult.mission.bonusXp : 0,
  };
  const xp = calculateXP(resultRecord);
  const progression = awardXP(xp.total);
  resultRecord.xpEarned = xp.total;
  saveHistoryRecord(resultRecord);
  renderXPResult(xp, progression);
  renderCareerResult(careerResult);
}

function renderXPResult(xp, progression) {
  const s = t();
  const level = progression.after;
  const nextText = level.next
    ? s.xpUntilNext(level.next.xp - progression.profile.totalXp, level.next.level)
    : s.maxLevel;
  const bonuses = [
    [s.xpBase, xp.correctXp],
    [s.xpErrorPenalty, -xp.errorPenalty],
    [s.xpAccuracyBonus, xp.accuracyBonus],
    [s.xpComboBonus, xp.comboBonus],
    [s.xpSpeedBonus, xp.speedBonus],
    [s.xpLargeTableBonus, xp.largeTableBonus],
    [s.xpCareerBonus, xp.careerBonus],
    [s.difficultyLabel, xp.difficultyBonus],
  ].filter(([, value]) => value !== 0);

  els.resultsXp.innerHTML = `
    <div class="xp-result-head">
      <span class="xp-earned">+${xp.total} XP</span>
      <span class="xp-result-level">${s.levelLabel(level.level)} · ${s[level.titleKey]}</span>
    </div>
    ${progression.leveledUp ? `<div class="level-up-banner"><span class="material-symbols-outlined">workspace_premium</span>${s.levelUp(level.level, s[level.titleKey])}</div>` : ""}
    <div class="xp-breakdown">${bonuses.map(([label, value]) => `<span>${label}<b class="${value < 0 ? "negative" : ""}">${value > 0 ? "+" : ""}${value}</b></span>`).join("")}</div>
    <div class="xp-progress-track"><div class="xp-progress-fill" style="width:${level.progress}%"></div></div>
    <p class="xp-next">${nextText}</p>`;
}

function renderCareerResult(result) {
  const s = t();
  if (!result) {
    els.resultsCareer.innerHTML = "";
    els.resultsCareer.classList.add("hidden");
    return;
  }
  const message = result.completed
    ? s.careerCompleteText(result.stars)
    : (!result.accuracyMet ? s.careerFailedText(result.mission.minPct) : s.careerFailedTime(result.mission.maxSeconds / 60));
  els.resultsCareer.classList.remove("hidden");
  els.resultsCareer.innerHTML = `
    <span class="material-symbols-outlined">${result.completed ? "verified" : "replay"}</span>
    <div><strong>${result.completed ? s.careerComplete : s.careerFailed}</strong><p>${message}</p></div>
    ${result.completed ? `<span class="career-result-stars">${"★".repeat(result.stars)}${"☆".repeat(3 - result.stars)}</span>` : ""}`;
}

// "Choose the dishes" screen: one checklist per category, pre-checked with
// a random subset (so the player can just tweak instead of starting from
// zero), plus Select all/Clear shortcuts per category and a live count
// against MENU_MIN. The actual selection is read back out in the
// btnMenuConfirm handler below, not here.
function renderMenuBuilder() {
  const s = t();
  els.menuBuilderTitle.textContent = s.menuBuilderTitle;
  els.menuBuilderHint.textContent = s.menuBuilderHint;
  els.btnMenuBack.innerHTML = `<span class="material-symbols-outlined">arrow_back</span>${s.backBtn}`;
  els.btnMenuConfirm.innerHTML = `<span class="material-symbols-outlined">play_arrow</span>${s.confirmMenuBtn}`;

  const defaults = {
    entrada: new Set(pickRandom(MENU_POOL.entrada, 6).map((i) => i.id)),
    principal: new Set(pickRandom(MENU_POOL.principal, 6).map((i) => i.id)),
    acompanhamento: new Set(pickRandom(MENU_POOL.acompanhamento, 5).map((i) => i.id)),
    sobremesa: new Set(pickRandom(MENU_POOL.sobremesa, 5).map((i) => i.id)),
    bebida: new Set(pickRandom(MENU_POOL.bebida, 6).map((i) => i.id)),
  };

  const cats = [
    ["entrada", s.catEntrada],
    ["principal", s.catPrincipal],
    ["acompanhamento", s.catAcompanhamento],
    ["sobremesa", s.catSobremesa],
    ["bebida", s.catBebida],
  ].filter(([key]) => (TRAINING_FOCUS[els.inputTrainingFocus.value] || TRAINING_FOCUS.complete).includes(key));

  els.menuBuilderContent.innerHTML = cats
    .map(([key, label]) => {
      const checks = MENU_POOL[key]
        .map((item) => {
          const checked = defaults[key].has(item.id) ? "checked" : "";
          return `<label class="mb-check"><input type="checkbox" data-cat="${key}" value="${item.id}" ${checked}> ${item[state.lang]}</label>`;
        })
        .join("");
      return `
        <div class="mb-cat">
          <div class="mb-cat-head">
            <h3><span class="material-symbols-outlined">${CATEGORY_ICONS[key]}</span>${label}</h3>
            <div class="mb-cat-actions">
              <button type="button" class="mb-mini-btn" data-action="all" data-cat="${key}">${s.selectAllBtn}</button>
              <button type="button" class="mb-mini-btn" data-action="none" data-cat="${key}">${s.clearAllBtn}</button>
            </div>
          </div>
          <div class="mb-count" data-count-for="${key}"></div>
          <div class="mb-checks">${checks}</div>
        </div>`;
    })
    .join("");

  updateMenuBuilderCounts();

  els.menuBuilderContent.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", updateMenuBuilderCounts);
  });
  els.menuBuilderContent.querySelectorAll(".mb-mini-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const cat = btn.dataset.cat;
      const checkedVal = btn.dataset.action === "all";
      els.menuBuilderContent.querySelectorAll(`input[data-cat="${cat}"]`).forEach((cb) => (cb.checked = checkedVal));
      updateMenuBuilderCounts();
    });
  });
}

// Refreshes each category's "N selected" line in the menu builder and
// flags it red when below MENU_MIN, so the player can see at a glance which
// categories still need more picks before they can start the table.
function updateMenuBuilderCounts() {
  const s = t();
  const active = TRAINING_FOCUS[els.inputTrainingFocus.value] || TRAINING_FOCUS.complete;
  Object.keys(MENU_MIN).filter((key) => active.includes(key)).forEach((key) => {
    const checked = els.menuBuilderContent.querySelectorAll(`input[data-cat="${key}"]:checked`).length;
    const min = MENU_MIN[key];
    const el = els.menuBuilderContent.querySelector(`[data-count-for="${key}"]`);
    const bad = checked < min;
    el.textContent = bad ? `${checked} — ${s.minWarning(min)}` : `${checked} ✅`;
    el.classList.toggle("mb-count-bad", bad);
  });
}

// Reads the setup form, builds the table, and switches from
// setup/menu-builder into the game screen. `customMenu` is null for a
// random menu, or the object assembled by the menu builder's confirm
// handler. Guest count is clamped to [1, 10] defensively even though the
// input already has those bounds, in case the value gets edited oddly.
function startTable(customMenu, options = {}) {
  const peopleCount = options.peopleCount ?? Math.min(10, Math.max(1, parseInt(els.inputPeople.value, 10) || 1));
  const recapEnabled = options.recapEnabled ?? els.inputRecap.checked;
  const orderStyle = options.orderStyle ?? els.inputOrderStyle.value;
  const trainingFocus = options.trainingFocus ?? els.inputTrainingFocus.value;
  const difficulty = options.difficulty ?? els.inputDifficulty.value;
  const similarOrders = options.similarOrders ?? els.inputSimilarOrders.checked;
  const rushHour = options.rushHour ?? els.inputRushHour.checked;

  state.table = buildTable(state.lang, peopleCount, recapEnabled, customMenu, orderStyle, trainingFocus, difficulty, similarOrders, rushHour);
  state.table.careerMissionId = options.careerMissionId || null;
  if (options.maxSeconds) state.table.maxSeconds = options.maxSeconds;
  state.registered = {};

  els.screenHome.classList.add("hidden");
  els.screenSetup.classList.add("hidden");
  els.screenMenuBuilder.classList.add("hidden");
  els.screenGame.classList.remove("hidden");

  renderMenuPanel();
  renderModeBanner();
  renderOrderStep();
}

function startCareerMission(missionId) {
  const mission = CAREER_MISSIONS.find((item) => item.id === missionId);
  if (!mission) return;
  state.lang = els.careerLang.value;
  els.inputLang.value = state.lang;
  applySetupUIText();
  setActiveView("training");
  startTable(null, {
    peopleCount: mission.people,
    recapEnabled: mission.recap,
    orderStyle: mission.orderStyle,
    trainingFocus: mission.trainingFocus || "complete",
    careerMissionId: mission.id,
    difficulty: mission.id === "maitre_test" ? "expert" : mission.id === "precision" || mission.id === "rush_hour" ? "hard" : "normal",
    similarOrders: mission.id === "precision" || mission.id === "maitre_test",
    rushHour: Boolean(mission.maxSeconds),
    maxSeconds: mission.maxSeconds,
  });
}

// "New Table" on the setup screen: either goes straight to a random-menu
// table, or detours through the menu builder first if the player asked to
// hand-pick the dishes.
els.btnStart.addEventListener("click", () => {
  state.lang = els.inputLang.value;
  if (els.inputMenuMode.value === "custom") {
    els.screenSetup.classList.add("hidden");
    els.screenMenuBuilder.classList.remove("hidden");
    renderMenuBuilder();
  } else {
    startTable(null);
  }
});

els.btnMenuBack.addEventListener("click", () => {
  els.screenMenuBuilder.classList.add("hidden");
  els.screenSetup.classList.remove("hidden");
});

// Validates the menu builder's selections against MENU_MIN, and either
// starts the table with that custom menu or re-runs the count display so
// the player can see which category(ies) still need more picks.
els.btnMenuConfirm.addEventListener("click", () => {
  const customMenu = {};
  const active = TRAINING_FOCUS[els.inputTrainingFocus.value] || TRAINING_FOCUS.complete;
  let valid = true;
  Object.keys(MENU_MIN).forEach((key) => {
    if (!active.includes(key)) {
      customMenu[key] = pickRandom(MENU_POOL[key], MENU_MIN[key]);
      return;
    }
    const ids = [...els.menuBuilderContent.querySelectorAll(`input[data-cat="${key}"]:checked`)].map((cb) => cb.value);
    if (ids.length < MENU_MIN[key]) valid = false;
    customMenu[key] = ids.map((id) => ALL_ITEMS[id]);
  });
  if (!valid) {
    updateMenuBuilderCounts();
    return;
  }
  startTable(customMenu);
});

// Formats a "Recent Activity" timestamp as e.g. "12 Mar, 14:30", localized
// to the current UI language. Reuses VOICE_LANG's locale codes purely as a
// convenient pt/en/es -> BCP-47 mapping — it has nothing to do with speech
// here, it's just already the right shape for Intl's locale argument.
function formatDateLabel(ts) {
  const locale = VOICE_LANG[state.lang];
  const dt = new Date(ts);
  const datePart = dt.toLocaleDateString(locale, { day: "2-digit", month: "short" });
  const timePart = dt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return `${datePart}, ${timePart}`;
}

// Rebuilds the entire Dashboard view from localStorage history: the three
// top stat cards, the per-course "Memory Strength" bars, the recent
// activity list, and the badge grid. Recomputed from scratch every time the
// Dashboard tab is opened (see setActiveView) rather than kept in sync
// incrementally, since it's cheap and only runs on a user-triggered tab
// switch.
function renderDashboard() {
  const s = t();
  const history = loadHistory();
  const stats = computeStats(history);
  const badges = computeBadges(history, stats);
  const profile = loadProfile();
  const playerLevel = levelForXP(profile.totalXp);

  const nextText = playerLevel.next
    ? s.xpUntilNext(playerLevel.next.xp - profile.totalXp, playerLevel.next.level)
    : s.maxLevel;
  els.progressionCard.innerHTML = `
    <div class="progression-main">
      <div class="level-medallion"><span>${playerLevel.level}</span><small>${s.levelWord}</small></div>
      <div class="progression-copy">
        <span class="progression-eyebrow">${s.currentTitle}</span>
        <h3>${s[playerLevel.titleKey]}</h3>
        <p>${profile.totalXp} XP · ${nextText}</p>
      </div>
    </div>
    <div class="progression-bar"><div style="width:${playerLevel.progress}%"></div></div>
    <div class="title-ladder">
      ${LEVELS.map((entry) => `<span class="${profile.totalXp >= entry.xp ? "unlocked" : ""}" title="${entry.xp} XP">${entry.level}. ${s[entry.titleKey]}</span>`).join("")}
    </div>`;

  const memberSince =
    history.length > 0
      ? new Date(stats.firstTs).toLocaleDateString(VOICE_LANG[state.lang], { month: "long", year: "numeric" })
      : "";

  els.dashboardStats.innerHTML = `
    <div class="stat-card">
      <span class="material-symbols-outlined">verified</span>
      <div class="stat-label">${s.statAccuracy}</div>
      <div class="stat-value">${stats.accuracyRate}%</div>
    </div>
    <div class="stat-card">
      <span class="material-symbols-outlined">calendar_today</span>
      <div class="stat-label">${s.statStreak}</div>
      <div class="stat-value">${stats.streak.current}</div>
      <div class="stat-sub">${s.statStreakRecord(stats.streak.best)}</div>
    </div>
    <div class="stat-card">
      <span class="material-symbols-outlined">receipt_long</span>
      <div class="stat-label">${s.statTotalTables}</div>
      <div class="stat-value">${stats.totalTables}</div>
      <div class="stat-sub">${history.length > 0 ? s.statMemberSince(memberSince) : ""}</div>
    </div>
    <div class="stat-card"><span class="material-symbols-outlined">military_tech</span><div class="stat-label">${s.statBestScore}</div><div class="stat-value">${stats.bestScore}%</div></div>
    <div class="stat-card"><span class="material-symbols-outlined">groups</span><div class="stat-label">${s.statGuestsServed}</div><div class="stat-value">${stats.guestsServed}</div></div>
    <div class="stat-card"><span class="material-symbols-outlined">table_restaurant</span><div class="stat-label">${s.statAverageTable}</div><div class="stat-value">${stats.averageTable}</div></div>
    <div class="stat-card"><span class="material-symbols-outlined">stars</span><div class="stat-label">${s.statTotalXp}</div><div class="stat-value">${profile.totalXp}</div>
    </div>`;

  const catOrder = ["bebida", "entrada", "principal", "acompanhamento", "sobremesa"];
  const catLabels = {
    bebida: s.catBebida,
    entrada: s.catEntrada,
    principal: s.catPrincipal,
    acompanhamento: s.catAcompanhamento,
    sobremesa: s.catSobremesa,
  };

  if (stats.totalTables === 0) {
    els.memoryStrengthBars.innerHTML = `<p class="empty-note">${s.memoryHint}</p>`;
  } else {
    els.memoryStrengthBars.innerHTML = catOrder
      .map((key) => {
        const c = stats.byCategory[key];
        const pct = c.total > 0 ? Math.round((c.correct / c.total) * 100) : 0;
        return `
          <div class="bar-row">
            <div class="bar-head"><span>${catLabels[key]}</span><span class="bar-pct">${pct}%</span></div>
            <div class="bar-track"><div class="bar-fill" data-width="${pct}"></div></div>
          </div>`;
      })
      .join("");
    requestAnimationFrame(() => {
      els.memoryStrengthBars.querySelectorAll(".bar-fill").forEach((el) => {
        el.style.width = `${el.dataset.width}%`;
      });
    });
  }

  if (stats.recent.length === 0) {
    els.recentActivityList.innerHTML = `<p class="empty-note">${s.noActivity}</p>`;
  } else {
    els.recentActivityList.innerHTML = stats.recent
      .map((r) => {
        const minutes = r.elapsedMs ? Math.max(1, Math.round(r.elapsedMs / 60000)) : null;
        return `
          <div class="activity-row">
            <div class="activity-icon"><span class="material-symbols-outlined">menu_book</span></div>
            <div class="activity-info">
              <h4>${s.tableSummary(r.peopleCount, r.mode)}</h4>
              <p>${formatDateLabel(r.ts)}</p>
            </div>
            <div class="activity-score">
              <span class="pct">${r.pct}%</span>
              <span class="time">${minutes ? s.minutesShort(minutes) : ""}</span>
            </div>
          </div>`;
      })
      .join("");
  }

  const trend = [...history].sort((a, b) => a.ts - b.ts).slice(-10);
  els.performanceTrend.innerHTML = trend.length
    ? `<div class="trend-chart">${trend.map((r, i) => `<div class="trend-column" title="${formatDateLabel(r.ts)} · ${r.pct}%"><b>${r.pct}%</b><span style="height:${Math.max(4, r.pct)}%"></span><small>${i + 1}</small></div>`).join("")}</div>`
    : `<p class="empty-note">${s.noData}</p>`;

  const measuredCats = catOrder.map((key) => {
    const c = stats.byCategory[key];
    return { key, pct: c.total ? Math.round(c.correct / c.total * 100) : null };
  }).filter((item) => item.pct !== null).sort((a, b) => b.pct - a.pct);
  const careerDone = CAREER_MISSIONS.filter((m) => loadCareer().missions[m.id]?.completed).length;
  els.performanceInsights.innerHTML = measuredCats.length ? `
    <div class="insight-grid">
      <div><span>${s.insightStrongest}</span><strong>${catLabels[measuredCats[0].key]} · ${measuredCats[0].pct}%</strong></div>
      <div><span>${s.insightWeakest}</span><strong>${catLabels[measuredCats.at(-1).key]} · ${measuredCats.at(-1).pct}%</strong></div>
      <div><span>${s.insightBestCombo}</span><strong>${stats.bestCombo}</strong></div>
      <div><span>${s.insightCareer}</span><strong>${careerDone}/${CAREER_MISSIONS.length}</strong></div>
    </div>` : `<p class="empty-note">${s.noData}</p>`;

  const breakdown = (key, values, labels) => values.map((value) => {
    const rows = history.filter((r) => (r[key] || (key === "difficulty" ? "normal" : null)) === value);
    const total = rows.reduce((sum, r) => sum + (r.total || 0), 0);
    const correct = rows.reduce((sum, r) => sum + (r.correct || 0), 0);
    const pct = total ? Math.round(correct / total * 100) : 0;
    return `<div class="breakdown-row"><span>${labels[value]}</span><div><i style="width:${pct}%"></i></div><b>${rows.length ? `${pct}%` : "—"}</b></div>`;
  }).join("");
  els.languageStats.innerHTML = breakdown("lang", ["pt","en","es"], {pt:"Português",en:"English",es:"Español"});
  els.difficultyStats.innerHTML = breakdown("difficulty", ["beginner","normal","hard","expert"], {
    beginner:s.difficultyBeginner, normal:s.difficultyNormal, hard:s.difficultyHard, expert:s.difficultyExpert
  });

  const badgeMeta = {
    firstService: { title: s.badgeFirstServiceTitle, desc: s.badgeFirstServiceDesc },
    elephant: { title: s.badgeElephantTitle, desc: s.badgeElephantDesc },
    sommelier: { title: s.badgeSommelierTitle, desc: s.badgeSommelierDesc },
    agile: { title: s.badgeAgileTitle, desc: s.badgeAgileDesc },
    cartmaster: { title: s.badgeCartmasterTitle, desc: s.badgeCartmasterDesc },
    gourmet: { title: s.badgeGourmetTitle, desc: s.badgeGourmetDesc },
    brigade: { title: s.badgeBrigadeTitle, desc: s.badgeBrigadeDesc },
    perfectFive: { title: s.badgePerfectFiveTitle, desc: s.badgePerfectFiveDesc },
    polyglot: { title: s.badgePolyglotTitle, desc: s.badgePolyglotDesc },
    rushMaster: { title: s.badgeRushMasterTitle, desc: s.badgeRushMasterDesc },
    confusionProof: { title: s.badgeConfusionProofTitle, desc: s.badgeConfusionProofDesc },
    careerGraduate: { title: s.badgeCareerGraduateTitle, desc: s.badgeCareerGraduateDesc },
  };
  els.badgesGrid.innerHTML = BADGES.map((b) => {
    const unlocked = badges[b.id];
    const meta = badgeMeta[b.id];
    return `
      <div class="badge-item tier-${b.tier || "bronze"} ${unlocked ? "" : "locked"}" title="${meta.desc}">
        <div class="badge-circle"><span class="material-symbols-outlined">${b.icon}</span></div>
        <span class="badge-label">${meta.title}</span>
        <small>${meta.desc}</small>
      </div>`;
  }).join("");
}

function renderCareer() {
  const s = t();
  const career = loadCareer();
  const completedCount = CAREER_MISSIONS.filter((mission) => career.missions[mission.id]?.completed).length;
  els.careerProgress.textContent = completedCount === CAREER_MISSIONS.length
    ? s.careerAllComplete
    : s.careerProgress(completedCount, CAREER_MISSIONS.length);
  els.careerLang.value = state.lang;

  els.careerGrid.innerHTML = CAREER_MISSIONS.map((mission, index) => {
    const record = career.missions[mission.id];
    const unlocked = index === 0 || career.missions[CAREER_MISSIONS[index - 1].id]?.completed;
    const complete = Boolean(record?.completed);
    const timeGoal = mission.maxSeconds ? s.careerTimeGoal(mission.maxSeconds / 60) : "";
    return `
      <article class="career-mission ${unlocked ? "" : "locked"} ${complete ? "complete" : ""}">
        <div class="mission-index">${String(index + 1).padStart(2, "0")}</div>
        <div class="mission-icon"><span class="material-symbols-outlined">${unlocked ? mission.icon : "lock"}</span></div>
        <div class="mission-copy">
          <div class="mission-title-row"><h3>${s[mission.titleKey]}</h3>${complete ? `<span class="mission-stars">${"★".repeat(record.stars)}${"☆".repeat(3 - record.stars)}</span>` : ""}</div>
          <p>${unlocked ? s[mission.descKey] : s.careerLocked}</p>
          <div class="mission-meta">
            <span><span class="material-symbols-outlined">groups</span>${mission.people}</span>
            <span><span class="material-symbols-outlined">target</span>${mission.minPct}%</span>
            ${mission.maxSeconds ? `<span><span class="material-symbols-outlined">timer</span>${mission.maxSeconds / 60} min</span>` : ""}
          </div>
          ${unlocked ? `<p class="mission-goal">${s.careerGoal(mission.minPct)}${timeGoal}. ${s.careerBonus(mission.bonusXp)}</p>` : ""}
        </div>
        <button class="${unlocked ? "btn-primary" : "btn-secondary"}" type="button" data-mission="${mission.id}" ${unlocked ? "" : "disabled"}>${complete ? s.careerReplay : s.careerStart}</button>
      </article>`;
  }).join("");

  els.careerGrid.querySelectorAll("button[data-mission]").forEach((button) => {
    button.addEventListener("click", () => startCareerMission(button.dataset.mission));
  });
}

// Switches between the top-level "Training" and "Dashboard" tabs. Whatever
// training screen was showing (setup, menu builder, or an in-progress
// table) is left exactly as it was underneath — this only toggles which of
// the two top-level views is visible, it doesn't reset any state.
function setActiveView(view) {
  if (view !== "training" || els.screenOrder.classList.contains("hidden")) stopAudio();
  if (view !== "training") stopTableTimer();
  els.viewTraining.classList.toggle("hidden", view !== "training");
  els.viewCareer.classList.toggle("hidden", view !== "career");
  els.viewDashboard.classList.toggle("hidden", view !== "dashboard");
  els.navTraining.classList.toggle("active", view === "training");
  els.navCareer.classList.toggle("active", view === "career");
  els.navDashboard.classList.toggle("active", view === "dashboard");
  if (view === "dashboard") renderDashboard();
  if (view === "career") renderCareer();
}

els.navTraining.addEventListener("click", () => setActiveView("training"));
els.navCareer.addEventListener("click", () => setActiveView("career"));
els.navDashboard.addEventListener("click", () => setActiveView("dashboard"));
els.btnDashboardStart.addEventListener("click", () => {
  setActiveView("training");
  showSetup();
});

els.btnResetProgress.addEventListener("click", () => {
  const s = t();
  if (!window.confirm(s.resetProgressConfirm)) return;
  saveProfile({ totalXp: 0, initialized: true });
  updatePlayerSummary();
  renderDashboard();
});

// Runs once, at script load: if there's a snapshot from persistSession()
// (i.e. the player refreshed or closed the tab mid-table instead of
// finishing or deliberately exiting), restore it and jump straight back
// into whichever screen they were on. Does nothing if there's no saved
// session, leaving the normal setup screen in place.
(function resumeSession() {
  const saved = restoreSession();
  if (!saved) return;

  state.lang = saved.lang;
  state.table = saved.table;
  state.registered = saved.registered || {};

  els.inputLang.value = state.lang;
  applySetupUIText();

  els.screenHome.classList.add("hidden");
  els.screenSetup.classList.add("hidden");
  els.screenGame.classList.remove("hidden");

  renderMenuPanel();
  renderModeBanner();

  if (saved.screen === "register") renderRegisterScreen();
  else if (saved.screen === "recap") renderRecapScreen();
  else renderOrderStep();
})();
