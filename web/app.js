const API_BASE = window.MLBB_API_BASE || "https://mlbb-draft-finder-api.onrender.com";
const ICON_BASE = "https://mlbbdex.com/visuels/heros";

const state = { heroes: [], entryMode: "our_picks", board: { our_picks: [], enemy_picks: [], bans: [] } };
const $ = (selector) => document.querySelector(selector);
const slug = (value) => value.toLowerCase().trim().replace(/['’]/g, "").replace(/\s+/g, "-");
const iconUrl = (hero) => `${ICON_BASE}/${hero.slug}/icone.webp`;
const heroBySlug = (value) => state.heroes.find((hero) => hero.slug === value);

function setStatus(text, kind = "") {
  const el = $("#api-status"); el.textContent = text; el.className = `status ${kind}`;
}

function renderBoard() {
  const counts = { our_picks: "our-count", enemy_picks: "enemy-count", bans: "ban-count" };
  for (const [bucket, items] of Object.entries(state.board)) {
    const target = $(`#${bucket}`);
    target.classList.toggle("empty", items.length === 0);
    target.innerHTML = items.length ? items.map((value) => {
      const hero = heroBySlug(value) || { slug: value, name: value };
      return `<span class="chip"><img src="${iconUrl(hero)}" alt=""><span>${hero.name}</span><button data-remove="${bucket}:${value}" aria-label="Remove ${hero.name}">×</button></span>`;
    }).join("") : "None";
    $(`#${counts[bucket]}`).textContent = items.length;
  }
  document.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    const [bucket, value] = button.dataset.remove.split(":");
    state.board[bucket] = state.board[bucket].filter((item) => item !== value);
    renderBoard(); renderHeroes();
  }));
}

function renderHeroes() {
  const search = $("#hero-search").value.toLowerCase();
  const selected = new Set(Object.values(state.board).flat());
  const heroes = state.heroes.filter((hero) => hero.name.toLowerCase().includes(search) || hero.slug.includes(search));
  $("#hero-grid").innerHTML = heroes.map((hero) => `<button class="hero-button" data-hero="${hero.slug}" ${selected.has(hero.slug) ? "disabled" : ""}><img src="${iconUrl(hero)}" alt=""><span>${hero.name}</span></button>`).join("");
  document.querySelectorAll("[data-hero]").forEach((button) => button.addEventListener("click", () => {
    const bucket = state.entryMode;
    const value = button.dataset.hero;
    if (!state.board[bucket].includes(value)) state.board[bucket].push(value);
    renderBoard(); renderHeroes();
  }));
}

function renderPools() {
  $("#pool-rows").innerHTML = Array.from({ length: 5 }, (_, index) => `<div class="pool-row">
    <input data-pool="player" data-index="${index}" placeholder="Player ${index + 1}">
    <input data-pool="roles" data-index="${index}" placeholder="Role (optional)">
    <input data-pool="can_play" data-index="${index}" placeholder="Can play: fredrinn, atlas">
    <input data-pool="cannot_play" data-index="${index}" placeholder="Cannot play: fanny">
  </div>`).join("");
}

function renderMode() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    const active = button.dataset.mode === state.entryMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function poolsPayload() {
  const rows = Array.from({ length: 5 }, (_, index) => {
    const get = (kind) => $(`[data-pool="${kind}"][data-index="${index}"]`).value.trim();
    const player = get("player");
    if (!player) return null;
    return { player, roles: get("roles") ? get("roles").split(",").map((v) => v.trim().toLowerCase()) : [],
      can_play: get("can_play") ? get("can_play").split(",").map(slug) : [],
      cannot_play: get("cannot_play") ? get("cannot_play").split(",").map(slug) : [] };
  });
  return rows.filter(Boolean);
}

function lineupHtml(items) {
  return items.map((value) => { const hero = heroBySlug(value) || { slug: value, name: value }; return `<span class="chip"><img src="${iconUrl(hero)}" alt=""><span>${hero.name}</span></span>`; }).join("");
}

function draftBox(title, items) {
  return `<div class="detail-box"><strong>${title}</strong><div class="mini-lineup">${items?.length ? lineupHtml(items) : "None captured"}</div></div>`;
}

function scoreLabel(candidate) {
  if (candidate.score == null) return { label: "No matchup fit", detail: "Add an enemy pick to compare fit." };
  const summary = candidate.score_summary || {};
  const known = summary.known_pairs || 0;
  const possible = summary.possible_pairs || 0;
  const games = summary.sample_games || 0;
  const coverage = possible ? Math.round((summary.coverage || 0) * 100) : 0;
  return { label: "Fit " + (candidate.score * 100).toFixed(1) + "%", detail: coverage + "% matchup coverage · " + known + "/" + possible + " rows · " + games + " games" };
}

function renderResults(candidates) {
  $("#result-summary").textContent = `${candidates.length} eligible historical draft${candidates.length === 1 ? "" : "s"}.`;
  $("#results").innerHTML = candidates.length ? candidates.map((candidate) => {
    const meta = candidate.metadata;
    const score = scoreLabel(candidate);
    return `<article class="result-card">
      <div class="result-top"><div><div class="result-title">${meta.tournament} | Game ${meta.game_number ?? "?"}</div><div class="result-meta">${meta.date || "Date unknown"} | ${meta.patch || "Patch unknown"} | ${meta.stage || "Stage unknown"}</div></div><div class="score-wrap"><span class="score">${score.label}</span><span class="score-detail">${score.detail}</span></div></div>
      <div class="duel-lineups"><div class="team-lineup matched"><div class="lineup-heading">${meta.matched_team || "Matched side"}</div><div class="lineup">${lineupHtml(candidate.our_picks || candidate.composition)}</div></div><div class="versus" aria-hidden="true">vs</div><div class="team-lineup opponent"><div class="lineup-heading">${meta.opponent_team || "Opponent"}</div><div class="lineup">${lineupHtml(candidate.opponent_picks || candidate.opponent_composition)}</div></div></div>
      <div class="result-details">${draftBox("Our bans", candidate.our_bans)}${draftBox("Opposing bans", candidate.opponent_bans)}<div class="detail-box remaining-box"><strong>Finish this side</strong><span>${candidate.remaining_picks.join(", ") || "Complete"}</span></div><div class="detail-box"><strong>Draft record</strong><span>${meta.order_available ? "Order captured" : "Order unavailable"} | ${meta.bans_known ? "Bans complete" : "Bans incomplete"}</span></div></div>
      <div class="result-links"><a href="${meta.source_url}" target="_blank" rel="noreferrer">Source page</a>${meta.source_refs?.filter((ref) => ref.url !== meta.source_url).map((ref) => `<a href="${ref.url}" target="_blank" rel="noreferrer">${ref.source}</a>`).join("") || ""}</div>
    </article>`;
  }).join("") : `<div class="empty-state">No historical composition fits this draft state.</div>`;
}

async function loadHeroes() {
  const response = await fetch(`${API_BASE}/v1/heroes`);
  if (!response.ok) throw new Error(`Hero request failed (${response.status})`);
  state.heroes = await response.json();
  renderHeroes(); renderBoard();
}

async function search() {
  $("#error").textContent = "";
  const button = $("#find-button"); button.disabled = true; button.textContent = "Searching…";
  try {
    const response = await fetch(`${API_BASE}/v1/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.board, player_pools: poolsPayload(), limit: 50 }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `Search failed (${response.status})`);
    renderResults(body.candidates);
  } catch (error) { $("#error").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "Find historical drafts"; }
}

$("#hero-search").addEventListener("input", renderHeroes);
document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
  state.entryMode = button.dataset.mode;
  renderMode();
}));
$("#clear-board").addEventListener("click", () => { state.board = { our_picks: [], enemy_picks: [], bans: [] }; renderBoard(); renderHeroes(); });
$("#find-button").addEventListener("click", search);
renderPools();
renderMode();
loadHeroes().then(() => setStatus("API connected", "ok")).catch((error) => { setStatus("API unavailable", "bad"); $("#error").textContent = error.message; });
