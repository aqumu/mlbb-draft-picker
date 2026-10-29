const API_BASE = window.MLBB_API_BASE || "https://mlbb-draft-finder-api.onrender.com";
const ICON_BASE = "https://mlbbdex.com/visuels/heros";

const state = {
  heroes: [],
  hidden: [],
  history: [],
  board: { our_picks: [], enemy_picks: [], bans: [] },
  simulation: { active: false, complete: false, format: "tournament", side: "blue side", stepIndex: 0, steps: [] },
};
const $ = (selector) => document.querySelector(selector);
const slug = (value) => value.toLowerCase().trim().replace(/[\u2019']/g, "").replace(/\s+/g, "-");
const iconUrl = (hero) => `${ICON_BASE}/${hero.slug}/icone.webp`;
const heroBySlug = (value) => state.heroes.find((hero) => hero.slug === value) || { slug: value, name: value, recent_picks: 0, recent_bans: 0 };
let searchTimer = null;
let searchRequestId = 0;
let apiState = "unknown";
let reconnectTimer = null;

const oppositeSide = (side) => side === "red side" ? "blue side" : "red side";
const sideClass = (side) => side === "red side" ? "side-red" : "side-blue";

function formatSteps(format, ourSide) {
  const steps = [];
  const add = (kind, actualSide, count, label) => {
    for (let index = 0; index < count; index += 1) steps.push({ kind, side: actualSide, team: actualSide === ourSide ? "our" : "enemy", label });
  };
  if (format === "regular") {
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    ["blue side", "red side", "red side", "blue side", "blue side", "red side", "red side", "blue side", "blue side", "red side"].forEach((side) => add("pick", side, 1, "Pick phase"));
  } else {
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    add("ban", "blue side", 1, "Ban phase"); add("ban", "red side", 1, "Ban phase");
    ["blue side", "red side", "red side", "blue side", "blue side", "red side"].forEach((side) => add("pick", side, 1, "Pick phase"));
    ["red side", "blue side", "red side", "blue side"].forEach((side) => add("ban", side, 1, "Second ban phase"));
    ["red side", "blue side", "blue side", "red side"].forEach((side) => add("pick", side, 1, "Pick phase"));
  }
  return steps;
}

function setStatus(text, kind = "") {
  const el = $("#api-toast");
  if (!el) return;
  if (kind === "ok" || !text) { el.hidden = true; return; }
  el.textContent = text;
  el.className = `api-toast ${kind}`;
  el.hidden = false;
}

function markConnecting() {
  apiState = "connecting";
  setStatus("Connecting…", "pending");
}

function markReconnecting() {
  apiState = "reconnecting";
  setStatus("Reconnecting…", "pending");
}

function markConnected() {
  apiState = "connected";
  clearTimeout(reconnectTimer);
  setStatus("", "ok");
}

function markDisconnected() {
  apiState = "disconnected";
  setStatus("Not connected", "bad");
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, options);
      markConnected();
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        if (apiState === "connected") markReconnecting(); else markConnecting();
        await wait(650);
      }
    }
  }
  markDisconnected();
  throw lastError;
}

function usedHeroes() {
  return new Set([...state.board.our_picks, ...state.board.enemy_picks, ...state.board.bans, ...state.hidden]);
}

function chipHtml(value, extra = "", draggable = false) {
  const hero = heroBySlug(value);
  const drag = draggable ? ` draggable="true" data-placed="${hero.slug}"` : "";
  return `<button class="icon-chip ${extra}" type="button" title="${hero.name}" aria-label="${hero.name}"${drag}><img src="${iconUrl(hero)}" alt="${hero.name}" draggable="false"></button>`;
}

function renderBoard() {
  const bans = state.history.filter((action) => action.kind === "ban");
  const renderRow = (selector, values, emptyText, team = null) => {
    const target = $(selector);
    target.classList.toggle("empty", values.length === 0);
    target.innerHTML = values.length ? values.map((value) => {
      const hero = typeof value === "string" ? value : value.hero;
      const actionTeam = typeof value === "string" ? team : value.team;
      const actionSide = actionTeam === "our" ? state.simulation.side : oppositeSide(state.simulation.side);
      return chipHtml(hero, sideClass(actionSide), !state.simulation.active);
    }).join("") : emptyText;
  };
  const ourBans = bans.filter((action) => action.team === "our");
  const enemyBans = bans.filter((action) => action.team === "enemy");
  renderRow("#our_bans", ourBans, "");
  renderRow("#enemy_bans", enemyBans, "");
  renderRow("#our_picks", state.board.our_picks, "", "our");
  renderRow("#enemy_picks", state.board.enemy_picks, "", "enemy");
  const enemySide = oppositeSide(state.simulation.side);
  $("#our-label").textContent = "Your team";
  $("#enemy-label").textContent = "Opponent";
  const step = state.simulation.active ? state.simulation.steps[state.simulation.stepIndex] : null;
  const firstPickTeam = state.simulation.side === "blue side" ? "our" : "enemy";
  const setPanelState = (selector, team, side) => {
    const panel = $(selector);
    const stateClass = state.simulation.complete ? "done" : step ? (step.team === team ? "active" : "waiting") : (team === firstPickTeam ? "ready" : "waiting");
    panel.className = `side-panel ${sideClass(side)} ${stateClass}`;
  };
  setPanelState("#our-panel", "our", state.simulation.side);
  setPanelState("#enemy-panel", "enemy", enemySide);

  const excluded = $("#excluded-wrap");
  excluded.hidden = state.hidden.length === 0;
  $("#excluded").innerHTML = state.hidden.map((value) => chipHtml(value, "excluded-chip")).join("");
}

function usageScore(hero) {
  return (hero.recent_picks || 0) + (hero.recent_bans || 0);
}

function renderHeroes() {
  const query = $("#hero-search").value.toLowerCase().trim();
  const used = usedHeroes();
  const heroes = state.heroes
    .filter((hero) => !used.has(hero.slug))
    .filter((hero) => !query || hero.name.toLowerCase().includes(query) || hero.slug.includes(query))
    .sort((a, b) => usageScore(b) - usageScore(a) || b.recent_bans - a.recent_bans || a.name.localeCompare(b.name));
  $("#hero-grid").innerHTML = heroes.map((hero) => `<button class="hero-button" type="button" draggable="true" data-hero="${hero.slug}" title="${hero.name} | ${hero.recent_picks || 0} picks | ${hero.recent_bans || 0} bans" aria-label="${hero.name}, ${hero.recent_picks || 0} recent picks, ${hero.recent_bans || 0} recent bans"><img src="${iconUrl(hero)}" alt="" draggable="false"><span class="hero-usage">P${hero.recent_picks || 0} | B${hero.recent_bans || 0}</span></button>`).join("") || `<div class="empty-state">No heroes match this filter.</div>`;
  document.querySelectorAll("[data-hero]").forEach((button) => button.addEventListener("click", () => handleHero(button.dataset.hero)));
}

function renderPools() {
  $("#pool-rows").innerHTML = Array.from({ length: 5 }, (_, index) => `<div class="pool-row">
    <input data-pool="player" data-index="${index}" placeholder="Player ${index + 1}">
    <input data-pool="roles" data-index="${index}" placeholder="Roles">
    <input data-pool="can_play" data-index="${index}" placeholder="Can play">
    <input data-pool="cannot_play" data-index="${index}" placeholder="Cannot play">
  </div>`).join("");
  document.querySelectorAll("[data-pool]").forEach((input) => input.addEventListener("input", scheduleSearch));
}

function poolsPayload() {
  return Array.from({ length: 5 }, (_, index) => {
    const get = (kind) => $(`[data-pool="${kind}"][data-index="${index}"]`).value.trim();
    const player = get("player");
    if (!player) return null;
    return { player, roles: get("roles") ? get("roles").split(",").map((value) => value.trim().toLowerCase()) : [],
      can_play: get("can_play") ? get("can_play").split(",").map(slug) : [],
      cannot_play: get("cannot_play") ? get("cannot_play").split(",").map(slug) : [] };
  }).filter(Boolean);
}

function renderPhase() {
  const { active, complete, stepIndex, steps } = state.simulation;
  const start = $("#start-simulation");
  if (!active && !complete) {
    start.textContent = "Start simulation";
    $("#phase-count").textContent = "Setup"; $("#progress-bar").style.width = "0%";
  } else if (complete) {
    start.textContent = "Start again";
    $("#phase-count").textContent = "Complete"; $("#progress-bar").style.width = "100%";
  } else {
    start.textContent = "Simulation running";
    const phaseLabel = state.simulation.format === "regular"
      ? (stepIndex < 6 ? "Triple ban phase" : "Triple pick phase")
      : stepIndex < 6 ? "Triple ban phase" : stepIndex < 12 ? "Triple pick phase" : stepIndex < 16 ? "Double ban phase" : "Double pick phase";
    $("#phase-count").textContent = phaseLabel;
    $("#progress-bar").style.width = `${(stepIndex / steps.length) * 100}%`;
  }
  start.disabled = active;
  $("#simulation-format").disabled = active;
  $("#team-side").disabled = active;
}

const banLimit = () => state.simulation.format === "regular" ? 3 : 5;

function removeHero(hero) {
  state.board.our_picks = state.board.our_picks.filter((value) => value !== hero);
  state.board.enemy_picks = state.board.enemy_picks.filter((value) => value !== hero);
  state.board.bans = state.board.bans.filter((value) => value !== hero);
  state.history = state.history.filter((action) => action.hero !== hero);
}

function placeHero(hero, team, kind) {
  const inBans = state.history.filter((action) => action.kind === "ban" && action.team === team);
  const current = kind === "pick" ? state.board[`${team}_picks`] : inBans.map((action) => action.hero);
  if (current.includes(hero) || current.length >= (kind === "pick" ? 5 : banLimit())) return;
  removeHero(hero);
  if (kind === "pick") state.board[`${team}_picks`].push(hero);
  else { state.board.bans.push(hero); state.history.push({ kind: "ban", team, hero }); }
}

function boardChanged() {
  renderBoard(); renderHeroes(); renderPhase();
  if (state.board.our_picks.length || state.board.enemy_picks.length || state.board.bans.length) scheduleSearch();
  else { searchRequestId += 1; $("#results").innerHTML = ""; }
}

let dragged = null;
document.addEventListener("dragstart", (event) => {
  const source = event.target.closest?.("[data-hero], [data-placed]");
  if (!source || state.simulation.active) return event.preventDefault();
  dragged = source.dataset.hero || source.dataset.placed;
  event.dataTransfer.setData("text/plain", dragged);
  event.dataTransfer.effectAllowed = "move";
});
document.addEventListener("dragend", () => { dragged = null; document.querySelectorAll(".drop-over").forEach((el) => el.classList.remove("drop-over")); });
document.querySelectorAll(".icon-row[id]").forEach((row) => {
  row.addEventListener("dragover", (event) => { if (dragged) { event.preventDefault(); row.classList.add("drop-over"); } });
  row.addEventListener("dragleave", () => row.classList.remove("drop-over"));
  row.addEventListener("drop", (event) => {
    event.preventDefault(); row.classList.remove("drop-over");
    if (!dragged || state.simulation.active) return;
    placeHero(dragged, row.id.startsWith("our") ? "our" : "enemy", row.id.endsWith("bans") ? "ban" : "pick");
    dragged = null; boardChanged();
  });
  row.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-placed]");
    if (!chip || state.simulation.active) return;
    removeHero(chip.dataset.placed); boardChanged();
  });
});
const grid = $("#hero-grid");
grid.addEventListener("dragover", (event) => { if (dragged) event.preventDefault(); });
grid.addEventListener("drop", (event) => {
  event.preventDefault();
  if (!dragged || state.simulation.active) return;
  removeHero(dragged); dragged = null; boardChanged();
});

function resetBoard(clearHidden = true) {
  state.board = { our_picks: [], enemy_picks: [], bans: [] };
  state.history = [];
  if (clearHidden) state.hidden = [];
}

function handleHero(hero) {
  if (!state.simulation.active) {
    if (!state.hidden.includes(hero)) state.hidden.push(hero);
    renderBoard(); renderHeroes();
    return;
  }
  const step = state.simulation.steps[state.simulation.stepIndex];
  if (!step || usedHeroes().has(hero)) return;
  if (step.kind === "ban") state.board.bans.push(hero);
  else state.board[step.team === "our" ? "our_picks" : "enemy_picks"].push(hero);
  state.history.push({ kind: step.kind, team: step.team, hero });
  state.simulation.stepIndex += 1;
  if (state.simulation.stepIndex >= state.simulation.steps.length) {
    state.simulation.active = false; state.simulation.complete = true;
  }
  renderBoard(); renderHeroes(); renderPhase(); scheduleSearch();
}

function startSimulation() {
  resetBoard(false);
  state.simulation.format = $("#simulation-format").value;
  state.simulation.side = $("#team-side").value;
  state.simulation.steps = formatSteps(state.simulation.format, state.simulation.side);
  state.simulation.stepIndex = 0; state.simulation.active = true; state.simulation.complete = false;
  renderBoard(); renderHeroes(); renderPhase(); scheduleSearch();
}

function resetSimulation() {
  resetBoard(true);
  state.simulation = { active: false, complete: false, format: $("#simulation-format").value, side: $("#team-side").value, stepIndex: 0, steps: [] };
  $("#results").innerHTML = "";
  renderBoard(); renderHeroes(); renderPhase();
}

function scoreLabel(candidate) {
  return { label: candidate.score == null ? "No matchup fit" : `Fit ${(candidate.score * 100).toFixed(1)}%` };
}

function lineupHtml(items) {
  return (items || []).map((value) => chipHtml(value)).join("");
}

function draftStrip(title, items) {
  return `<div class="found-strip"><span>${title}</span><div class="found-icons">${items?.length ? lineupHtml(items) : "None captured"}</div></div>`;
}

function renderResults(candidates) {
  $("#results").innerHTML = candidates.length ? candidates.map((candidate) => {
    const meta = candidate.metadata; const score = scoreLabel(candidate);
    return `<article class="result-card">
      <div class="result-top"><div><div class="result-title">${meta.tournament} | Game ${meta.game_number ?? "?"}</div><div class="result-meta">${[meta.date, meta.patch, meta.stage].filter(Boolean).join(" | ")}</div></div><div class="score-wrap"><span class="score">${score.label}</span></div></div>
      ${draftStrip("Bans | our side", candidate.our_bans)}${draftStrip("Bans | opponent", candidate.opponent_bans)}
      <div class="found-picks"><div class="found-team matched"><span>${meta.matched_team || "Our side"}</span><div class="found-icons">${lineupHtml(candidate.our_picks || candidate.composition)}</div></div><span class="versus">vs</span><div class="found-team opponent"><span>${meta.opponent_team || "Opponent"}</span><div class="found-icons">${lineupHtml(candidate.opponent_picks || candidate.opponent_composition)}</div></div></div>
      <div class="result-footer"><div><strong>Finish our side</strong><div class="found-icons">${lineupHtml(candidate.remaining_picks)}</div></div></div>
      <div class="result-links"><a href="${meta.source_url}" target="_blank" rel="noreferrer">Source page</a>${meta.source_refs?.filter((ref) => ref.url !== meta.source_url).map((ref) => `<a href="${ref.url}" target="_blank" rel="noreferrer">${ref.source}</a>`).join("") || ""}</div>
    </article>`;
  }).join("") : `<div class="empty-state">No historical composition fits this board yet.</div>`;
}

async function search() {
  if (!state.simulation.active && !state.board.our_picks.length && !state.board.enemy_picks.length && !state.board.bans.length) return;
  const requestId = ++searchRequestId;
  try {
    const response = await request(`${API_BASE}/v1/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.board, our_side: state.simulation.side, excluded_heroes: state.hidden, player_pools: poolsPayload(), limit: 50 }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `Search failed (${response.status})`);
    if (requestId === searchRequestId) renderResults(body.candidates);
  } catch (error) { if (requestId === searchRequestId) $("#results").innerHTML = `<div class="empty-state error">${error.message}</div>`; }
}

function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(search, 140);
}

async function loadHeroes() {
  markConnecting();
  const response = await request(`${API_BASE}/v1/heroes`);
  if (!response.ok) throw new Error(`Hero request failed (${response.status})`);
  state.heroes = await response.json();
  renderBoard(); renderHeroes(); renderPhase();
}

$("#hero-search").addEventListener("input", renderHeroes);
$("#start-simulation").addEventListener("click", startSimulation);
$("#reset-simulation").addEventListener("click", resetSimulation);
$("#restore-hidden").addEventListener("click", () => { state.hidden = []; renderBoard(); renderHeroes(); });
$("#simulation-format").addEventListener("change", () => { state.simulation.format = $("#simulation-format").value; renderBoard(); });
$("#team-side").addEventListener("change", () => { state.simulation.side = $("#team-side").value; renderBoard(); renderPhase(); });
renderPools(); renderPhase();
loadHeroes().catch((error) => { markDisconnected(); $("#results").innerHTML = `<div class="empty-state error">${error.message}</div>`; });
