const API_BASE = window.MLBB_API_BASE || "https://mlbb-draft-finder-api.onrender.com";
const ICON_BASE = "https://mlbbdex.com/visuels/heros";

const state = {
  heroes: [],
  hidden: [],
  history: [],
  board: { our_picks: [], enemy_picks: [], bans: [] },
  simulation: { active: false, complete: false, format: "tournament", stepIndex: 0, steps: [] },
};
const $ = (selector) => document.querySelector(selector);
const slug = (value) => value.toLowerCase().trim().replace(/[\u2019']/g, "").replace(/\s+/g, "-");
const iconUrl = (hero) => `${ICON_BASE}/${hero.slug}/icone.webp`;
const heroBySlug = (value) => state.heroes.find((hero) => hero.slug === value) || { slug: value, name: value, recent_picks: 0, recent_bans: 0 };
let searchTimer = null;
let searchRequestId = 0;

const setupText = "Before starting, click heroes to hide the ones your team will not play.";

function formatSteps(format) {
  const steps = [];
  const add = (kind, team, count, label) => { for (let index = 0; index < count; index += 1) steps.push({ kind, team, label }); };
  if (format === "regular") {
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    ["our", "enemy", "enemy", "our", "our", "enemy", "enemy", "our", "our", "enemy"].forEach((team) => steps.push({ kind: "pick", team, label: team === "our" ? "Our pick" : "Opponent pick" }));
  } else {
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    add("ban", "our", 1, "Ban"); add("ban", "enemy", 1, "Ban");
    ["our", "enemy", "enemy", "our", "our", "enemy"].forEach((team) => steps.push({ kind: "pick", team, label: team === "our" ? "Our pick" : "Opponent pick" }));
    ["enemy", "our", "enemy", "our"].forEach((team) => steps.push({ kind: "ban", team, label: "Second ban" }));
    ["enemy", "our", "enemy", "our"].forEach((team) => steps.push({ kind: "pick", team, label: team === "our" ? "Our pick" : "Opponent pick" }));
  }
  return steps;
}

function setStatus(text, kind = "") {
  const el = $("#api-status"); el.textContent = text; el.className = `status ${kind}`;
}

function usedHeroes() {
  return new Set([...state.board.our_picks, ...state.board.enemy_picks, ...state.board.bans, ...state.hidden]);
}

function chipHtml(value, extra = "") {
  const hero = heroBySlug(value);
  return `<button class="icon-chip ${extra}" type="button" title="${hero.name}" aria-label="${hero.name}"><img src="${iconUrl(hero)}" alt="${hero.name}"></button>`;
}

function renderBoard() {
  const bans = state.history.filter((action) => action.kind === "ban").map((action) => action.hero);
  const renderRow = (selector, values, emptyText) => {
    const target = $(selector);
    target.classList.toggle("empty", values.length === 0);
    target.innerHTML = values.length ? values.map((value) => chipHtml(value)).join("") : emptyText;
  };
  renderRow("#bans", bans, "No bans yet");
  renderRow("#our_picks", state.board.our_picks, "No picks yet");
  renderRow("#enemy_picks", state.board.enemy_picks, "No picks yet");
  $("#ban-count").textContent = `${bans.length} / ${state.simulation.format === "regular" ? 6 : 10}`;
  $("#our-count").textContent = `${state.board.our_picks.length} / 5`;
  $("#enemy-count").textContent = `${state.board.enemy_picks.length} / 5`;

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
  $("#hero-grid").innerHTML = heroes.map((hero) => `<button class="hero-button" type="button" data-hero="${hero.slug}" title="${hero.name} | ${hero.recent_picks || 0} picks | ${hero.recent_bans || 0} bans" aria-label="${hero.name}, ${hero.recent_picks || 0} recent picks, ${hero.recent_bans || 0} recent bans"><img src="${iconUrl(hero)}" alt=""><span class="hero-usage">P${hero.recent_picks || 0} | B${hero.recent_bans || 0}</span></button>`).join("") || `<div class="empty-state">No heroes match this filter.</div>`;
  document.querySelectorAll("[data-hero]").forEach((button) => button.addEventListener("click", () => handleHero(button.dataset.hero)));
}

function renderPools() {
  $("#pool-rows").innerHTML = Array.from({ length: 5 }, (_, index) => `<div class="pool-row">
    <input data-pool="player" data-index="${index}" placeholder="Player ${index + 1}">
    <input data-pool="roles" data-index="${index}" placeholder="Role">
    <input data-pool="can_play" data-index="${index}" placeholder="Can play: fredrinn, atlas">
    <input data-pool="cannot_play" data-index="${index}" placeholder="Cannot play: fanny">
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
  const label = $("#phase-label");
  const detail = $("#phase-detail");
  const start = $("#start-simulation");
  if (!active && !complete) {
    label.textContent = "Setup"; detail.textContent = setupText; start.textContent = "Start simulation";
    $("#phase-count").textContent = "Setup"; $("#phase-next").textContent = "Click a hero to hide it"; $("#progress-bar").style.width = "0%";
  } else if (complete) {
    label.textContent = "Draft complete"; detail.textContent = "Review the matching professional drafts below."; start.textContent = "Start again";
    $("#phase-count").textContent = `${steps.length} / ${steps.length}`; $("#phase-next").textContent = "All actions recorded"; $("#progress-bar").style.width = "100%";
  } else {
    const step = steps[stepIndex];
    label.textContent = step.label;
    detail.textContent = step.kind === "ban" ? "Click a hero to ban it." : `Click a hero for the ${step.team === "our" ? "our side" : "opponent"}.`;
    start.textContent = "Simulation running";
    $("#phase-count").textContent = `${stepIndex + 1} / ${steps.length}`; $("#phase-next").textContent = step.kind === "ban" ? "Ban phase" : "Pick phase";
    $("#progress-bar").style.width = `${(stepIndex / steps.length) * 100}%`;
  }
  start.disabled = active;
  $("#simulation-format").disabled = active;
}

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
  state.simulation.steps = formatSteps(state.simulation.format);
  state.simulation.stepIndex = 0; state.simulation.active = true; state.simulation.complete = false;
  renderBoard(); renderHeroes(); renderPhase(); scheduleSearch();
}

function resetSimulation() {
  resetBoard(true);
  state.simulation = { active: false, complete: false, format: $("#simulation-format").value, stepIndex: 0, steps: [] };
  $("#results").innerHTML = `<div class="empty-state">Your candidate drafts will appear here as the board changes.</div>`;
  $("#result-summary").textContent = "Start the simulation to see eligible drafts.";
  renderBoard(); renderHeroes(); renderPhase();
}

function scoreLabel(candidate) {
  if (candidate.score == null) return { label: "No matchup fit", detail: "Add an enemy pick to compare fit." };
  const summary = candidate.score_summary || {};
  const known = summary.known_pairs || 0; const possible = summary.possible_pairs || 0; const games = summary.sample_games || 0;
  const coverage = possible ? Math.round((summary.coverage || 0) * 100) : 0;
  return { label: `Fit ${(candidate.score * 100).toFixed(1)}%`, detail: `${coverage}% coverage | ${known}/${possible} rows | ${games} games` };
}

function lineupHtml(items) {
  return (items || []).map((value) => chipHtml(value)).join("");
}

function draftStrip(title, items) {
  return `<div class="found-strip"><span>${title}</span><div class="found-icons">${items?.length ? lineupHtml(items) : "None captured"}</div></div>`;
}

function renderResults(candidates) {
  $("#result-summary").textContent = `${candidates.length} eligible historical draft${candidates.length === 1 ? "" : "s"}.`;
  $("#results").innerHTML = candidates.length ? candidates.map((candidate) => {
    const meta = candidate.metadata; const score = scoreLabel(candidate);
    return `<article class="result-card">
      <div class="result-top"><div><div class="result-title">${meta.tournament} | Game ${meta.game_number ?? "?"}</div><div class="result-meta">${meta.date || "Date unknown"} | ${meta.patch || "Patch unknown"} | ${meta.stage || "Stage unknown"}</div></div><div class="score-wrap"><span class="score">${score.label}</span><span class="score-detail">${score.detail}</span></div></div>
      ${draftStrip("Bans | our side", candidate.our_bans)}${draftStrip("Bans | opponent", candidate.opponent_bans)}
      <div class="found-picks"><div class="found-team matched"><span>${meta.matched_team || "Our side"}</span><div class="found-icons">${lineupHtml(candidate.our_picks || candidate.composition)}</div></div><span class="versus">vs</span><div class="found-team opponent"><span>${meta.opponent_team || "Opponent"}</span><div class="found-icons">${lineupHtml(candidate.opponent_picks || candidate.opponent_composition)}</div></div></div>
      <div class="result-footer"><div><strong>Finish our side</strong><div class="found-icons">${lineupHtml(candidate.remaining_picks)}</div></div><span>${meta.order_available ? "Order captured" : "Order unavailable"} | ${meta.bans_known ? "Bans complete" : "Bans incomplete"}</span></div>
      <div class="result-links"><a href="${meta.source_url}" target="_blank" rel="noreferrer">Source page</a>${meta.source_refs?.filter((ref) => ref.url !== meta.source_url).map((ref) => `<a href="${ref.url}" target="_blank" rel="noreferrer">${ref.source}</a>`).join("") || ""}</div>
    </article>`;
  }).join("") : `<div class="empty-state">No historical composition fits this board yet.</div>`;
}

async function search() {
  if (!state.simulation.active && !state.simulation.complete) return;
  const requestId = ++searchRequestId;
  try {
    const response = await fetch(`${API_BASE}/v1/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.board, excluded_heroes: state.hidden, player_pools: poolsPayload(), limit: 50 }) });
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
  const response = await fetch(`${API_BASE}/v1/heroes`);
  if (!response.ok) throw new Error(`Hero request failed (${response.status})`);
  state.heroes = await response.json();
  renderBoard(); renderHeroes(); renderPhase();
}

$("#hero-search").addEventListener("input", renderHeroes);
$("#start-simulation").addEventListener("click", startSimulation);
$("#reset-simulation").addEventListener("click", resetSimulation);
$("#restore-hidden").addEventListener("click", () => { state.hidden = []; renderBoard(); renderHeroes(); });
$("#simulation-format").addEventListener("change", () => { state.simulation.format = $("#simulation-format").value; renderBoard(); });
renderPools(); renderPhase();
loadHeroes().then(() => setStatus("API connected", "ok")).catch((error) => { setStatus("API unavailable", "bad"); $("#results").innerHTML = `<div class="empty-state error">${error.message}</div>`; });
