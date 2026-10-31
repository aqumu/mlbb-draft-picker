const API_BASE = window.MLBB_API_BASE || "https://mlbb-draft-finder-api.onrender.com";
const ICON_BASE = "https://mlbbdex.com/visuels/heros";

const state = {
  heroes: [],
  selected: null,
  hidden: [],
  history: [],
  board: { our_picks: [], enemy_picks: [], bans: [] },
  simulation: { active: false, complete: false, format: "tournament", side: "blue side", stepIndex: 0, steps: [] },
};
const POOLS_KEY = "mlbb-draft-finder.pools.v2";
const MASTERY = { 1: "Learning", 2: "Average", 3: "Master" };
const LANES = { exp: "EXP", mid: "Mid", jungle: "Jungle", gold: "Gold", roam: "Roam" };
const loadPools = () => {
  const blank = Array.from({ length: 5 }, () => ({ name: "", lanes: {} }));
  try {
    const saved = JSON.parse(localStorage.getItem(POOLS_KEY));
    if (Array.isArray(saved)) return blank.map((player, index) => ({ name: String(saved[index]?.name || ""), lanes: { ...(saved[index]?.lanes || {}) } }));
    const legacy = JSON.parse(localStorage.getItem("mlbb-draft-finder.pools.v1")); // names only: v1 heroes had no lane
    if (Array.isArray(legacy)) return blank.map((player, index) => ({ ...player, name: String(legacy[index]?.name || "") }));
  } catch { /* unreadable or unavailable storage: start empty */ }
  return blank;
};
state.pools = loadPools();
const savePools = () => { try { localStorage.setItem(POOLS_KEY, JSON.stringify(state.pools)); } catch { /* storage unavailable */ } };
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
  setStatus("Waking the server. The first load can take up to a minute…", "pending");
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

function chipHtml(value, extra = "", attrs = "", title = "") {
  const hero = heroBySlug(value);
  return `<button class="icon-chip ${extra}" type="button" title="${title || hero.name}" aria-label="${hero.name}" ${attrs}><img src="${iconUrl(hero)}" alt="${hero.name}" draggable="false"></button>`;
}

// Which lanes the picks still leave open. Heroes without lane data can go anywhere.
function laneStatus(picks) {
  if (!picks.length) return "";
  const all = Object.keys(LANES);
  const options = picks.map((value) => { const lanes = heroBySlug(value).lanes || []; return lanes.length ? lanes : all; });
  const unusedSets = [];
  const walk = (index, used) => {
    if (index === options.length) { unusedSets.push(all.filter((lane) => !used.has(lane))); return; }
    options[index].forEach((lane) => { if (!used.has(lane)) walk(index + 1, new Set([...used, lane])); });
  };
  walk(0, new Set());
  if (!unusedSets.length) return `<span class="lane-clash">Lane clash: two picks need the same lane</span>`;
  const sure = all.filter((lane) => unusedSets.every((set) => set.includes(lane)));
  const maybe = all.filter((lane) => !sure.includes(lane) && unusedSets.some((set) => set.includes(lane)));
  const left = 5 - picks.length;
  const parts = [];
  if (sure.length) parts.push(`Needs ${sure.map((lane) => LANES[lane]).join(", ")}`);
  const flexSlots = left - sure.length;
  if (flexSlots > 0 && maybe.length) parts.push(`${sure.length ? "+ " : ""}${flexSlots} of ${maybe.map((lane) => LANES[lane]).join("/")}`);
  return parts.join(" ") || "Lanes full";
}

function turnContext() {
  const { active, complete, stepIndex, steps } = state.simulation;
  if (complete) return "Draft complete";
  if (!active) return "";
  const step = steps[stepIndex];
  const same = (other) => other && other.team === step.team && other.kind === step.kind;
  let before = 0; while (same(steps[stepIndex - 1 - before])) before += 1;
  let after = 0; while (same(steps[stepIndex + 1 + after])) after += 1;
  const total = before + after + 1;
  return `${step.team === "our" ? "Your" : "Enemy"} ${step.kind}${total > 1 ? ` ${before + 1} of ${total}` : ""}`;
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
      return chipHtml(hero, sideClass(actionSide), state.simulation.active ? "" : `draggable="true" data-placed="${hero}"`);
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

  $("#our_lanes").innerHTML = laneStatus(state.board.our_picks);
  $("#enemy_lanes").innerHTML = laneStatus(state.board.enemy_picks);

  const excluded = $("#excluded-wrap");
  excluded.hidden = state.hidden.length === 0;
  $("#excluded").innerHTML = state.hidden.map((value) => chipHtml(value, "excluded-chip", `data-restore="${value}"`, `Restore ${heroBySlug(value).name}`)).join("");
}

function usageScore(hero) {
  return (hero.recent_picks || 0) + (hero.recent_bans || 0);
}

let laneFilter = "";

function renderHeroes() {
  const query = $("#hero-search").value.toLowerCase().trim();
  const used = usedHeroes();
  const step = state.simulation.active ? state.simulation.steps[state.simulation.stepIndex] : null;
  const ourTurn = step?.kind === "pick" && step.team === "our";
  const heroes = state.heroes
    .filter((hero) => !used.has(hero.slug))
    .filter((hero) => !laneFilter || (hero.lanes || []).includes(laneFilter))
    .filter((hero) => !query || hero.name.toLowerCase().includes(query) || hero.slug.includes(query))
    .sort((a, b) => usageScore(b) - usageScore(a) || b.recent_bans - a.recent_bans || a.name.localeCompare(b.name));
  $("#hero-grid").innerHTML = heroes.map((hero) => `<button class="hero-button${ourTurn && !teamCanPlay(hero.slug) ? " unplayable" : ""}${state.selected === hero.slug ? " selected" : ""}" type="button" draggable="true" data-hero="${hero.slug}" title="${hero.name} | ${hero.recent_picks || 0} picks | ${hero.recent_bans || 0} bans${ourTurn && !teamCanPlay(hero.slug) ? " | nobody on your team plays this" : ""}" aria-label="${hero.name}, ${hero.recent_picks || 0} recent picks, ${hero.recent_bans || 0} recent bans"><img src="${iconUrl(hero)}" alt="" draggable="false"><span class="hero-usage">P${hero.recent_picks || 0} | B${hero.recent_bans || 0}</span></button>`).join("") || `<div class="empty-state">No heroes match this filter.</div>`;
  document.querySelectorAll("[data-hero]").forEach((button) => button.addEventListener("click", () => handleHero(button.dataset.hero)));
}

const laneHeroes = (player) => Object.values(player.lanes).flatMap((heroes) => Object.keys(heroes));
const poolsActive = () => state.pools.some((player) => laneHeroes(player).length);
const playerName = (index) => state.pools[index].name.trim() || `Player ${index + 1}`;

// A hero is out when no player can play it in any lane. Players without lanes, and lanes without heroes, are open to anything.
function teamCanPlay(hero) {
  return !poolsActive() || state.pools.some((player) => {
    const lanes = Object.values(player.lanes);
    return !lanes.length || lanes.some((heroes) => !Object.keys(heroes).length || hero in heroes);
  });
}

function renderPools() {
  $("#pool-rows").innerHTML = state.pools.map((player, index) => {
    const toggles = Object.entries(LANES).map(([lane, label]) => `<button type="button" class="lane-toggle${lane in player.lanes ? " on" : ""}" data-lane-toggle="${lane}" aria-pressed="${lane in player.lanes}">${label}</button>`).join("");
    const lanes = Object.keys(LANES).filter((lane) => lane in player.lanes).map((lane) => {
      const chips = Object.entries(player.lanes[lane]).map(([hero, level]) => {
        const info = heroBySlug(hero);
        return `<div class="pool-hero level-${level}"><button type="button" class="pool-hero-pick" data-cycle="${hero}" title="${info.name}: ${MASTERY[level]}. Click to change."><img src="${iconUrl(info)}" alt="${info.name}" draggable="false"><span>${MASTERY[level]}</span></button><button type="button" class="pool-hero-x" data-remove="${hero}" aria-label="Remove ${info.name}" title="Remove">×</button></div>`;
      }).join("");
      return `<div class="lane-pool" data-lane="${lane}"><span class="lane-label">${LANES[lane]}</span><div class="lane-heroes">${chips || `<span class="pool-any">Any hero. Drag heroes here to limit.</span>`}</div></div>`;
    }).join("");
    return `<div class="pool-row" data-player="${index}">
      <div class="pool-who">
        <input class="pool-name" data-name placeholder="Player ${index + 1}" value="${player.name.replace(/"/g, "&quot;")}" aria-label="Player ${index + 1} name">
        <div class="lane-toggles">${toggles}</div>
      </div>
      <div class="pool-lanes">${lanes || `<span class="pool-any">Choose the lanes this player plays. No lane means anything goes.</span>`}</div>
    </div>`;
  }).join("");
  const set = state.pools.filter((player) => laneHeroes(player).length).length;
  $("#pool-summary").textContent = set ? `${set} / 5 set` : "";
}

function poolsChanged() {
  savePools(); renderPools(); renderHeroes();
  scheduleSearch();
}

const pool = (target) => state.pools[Number(target.closest("[data-player]").dataset.player)];

$("#pool-rows").addEventListener("input", (event) => {
  if (!event.target.matches("[data-name]")) return;
  pool(event.target).name = event.target.value;
  savePools(); scheduleSearch();
});
$("#pool-rows").addEventListener("click", (event) => {
  if (!event.target.closest("[data-player]")) return;
  const player = pool(event.target);
  const toggle = event.target.closest("[data-lane-toggle]");
  const lane = event.target.closest("[data-lane]")?.dataset.lane;
  const cycle = event.target.closest("[data-cycle]"); const remove = event.target.closest("[data-remove]");
  if (toggle) {
    const key = toggle.dataset.laneToggle;
    if (key in player.lanes) delete player.lanes[key]; else player.lanes[key] = {};
  } else if (cycle && lane) player.lanes[lane][cycle.dataset.cycle] = player.lanes[lane][cycle.dataset.cycle] % 3 + 1;
  else if (remove && lane) delete player.lanes[lane][remove.dataset.remove];
  else return;
  poolsChanged();
});
$("#pool-rows").addEventListener("dragover", (event) => { if (dragged && event.target.closest(".lane-pool")) { event.preventDefault(); event.target.closest(".lane-pool").classList.add("drop-over"); } });
$("#pool-rows").addEventListener("dragleave", (event) => event.target.closest(".lane-pool")?.classList.remove("drop-over"));
$("#pool-rows").addEventListener("drop", (event) => {
  const target = event.target.closest(".lane-pool");
  if (!target || !dragged) return;
  event.preventDefault();
  const heroes = pool(target).lanes[target.dataset.lane];
  if (!(dragged in heroes)) heroes[dragged] = 2;
  dragged = null;
  poolsChanged();
});
$("#clear-pools").addEventListener("click", () => {
  if (!state.pools.some((player) => player.name || Object.keys(player.lanes).length) || !confirm("Clear all player pools?")) return;
  state.pools = state.pools.map(() => ({ name: "", lanes: {} }));
  poolsChanged();
});

// Players are sent by index so duplicate or blank names never collide; heroes carry mastery levels.
function poolsPayload() {
  if (!poolsActive()) return [];
  return state.pools.map((player, index) => ({ player: `p${index}`, lanes: player.lanes }));
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
  $("#turn-context").textContent = turnContext();
  $("#undo-step").disabled = !(state.simulation.steps.length && stepIndex > 0 && state.history.length === stepIndex);
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
  state.selected = null;
  renderBoard(); renderHeroes(); renderPhase(); renderHeroActions();
  scheduleSearch();
}

let dragged = null;
document.addEventListener("dragstart", (event) => {
  const source = event.target.closest?.("[data-hero], [data-placed]");
  if (!source || (state.simulation.active && source.dataset.placed)) return event.preventDefault();
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

const clearSearch = () => { $("#hero-search").value = ""; $("#hero-search").focus(); };

function renderHeroActions() {
  const bar = $("#hero-actions");
  const hero = state.selected;
  bar.hidden = !hero;
  if (!hero) return;
  const full = (team, kind) => (kind === "pick" ? state.board[`${team}_picks`].length >= 5
    : state.history.filter((action) => action.kind === "ban" && action.team === team).length >= banLimit());
  const button = (act, label, disabled) => `<button type="button" class="button subtle" data-act="${act}"${disabled ? " disabled" : ""}>${label}</button>`;
  bar.innerHTML = `<strong>${heroBySlug(hero).name}</strong>${button("our-pick", "Our pick", full("our", "pick"))}${button("our-ban", "Our ban", full("our", "ban"))}${button("enemy-pick", "Enemy pick", full("enemy", "pick"))}${button("enemy-ban", "Enemy ban", full("enemy", "ban"))}${button("hide", "Hide from our team")}${button("cancel", "Cancel")}`;
}

$("#hero-actions").addEventListener("click", (event) => {
  const act = event.target.closest("[data-act]")?.dataset.act;
  const hero = state.selected;
  if (!act || !hero) return;
  state.selected = null;
  if (act === "hide") { if (!state.hidden.includes(hero)) state.hidden.push(hero); }
  else if (act !== "cancel") { const [team, kind] = act.split("-"); placeHero(hero, team, kind); }
  clearSearch(); boardChanged();
});

function selectHero(hero) {
  state.selected = state.selected === hero ? null : hero;
  renderHeroes(); renderHeroActions();
}

function undoStep() {
  const sim = state.simulation;
  if (!sim.steps.length || !sim.stepIndex || state.history.length !== sim.stepIndex) return;
  const last = state.history.pop();
  for (const key of ["our_picks", "enemy_picks", "bans"]) state.board[key] = state.board[key].filter((value) => value !== last.hero);
  sim.stepIndex -= 1; sim.active = true; sim.complete = false;
  boardChanged();
}

function handleHero(hero) {
  if (!state.simulation.active) { selectHero(hero); return; }
  const step = state.simulation.steps[state.simulation.stepIndex];
  if (!step || usedHeroes().has(hero)) return;
  if (step.kind === "ban") state.board.bans.push(hero);
  else state.board[step.team === "our" ? "our_picks" : "enemy_picks"].push(hero);
  state.history.push({ kind: step.kind, team: step.team, hero });
  clearSearch();
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
  state.selected = null; renderHeroActions();
  renderBoard(); renderHeroes(); renderPhase(); scheduleSearch();
}

function resetSimulation() {
  resetBoard(true);
  state.simulation = { active: false, complete: false, format: $("#simulation-format").value, side: $("#team-side").value, stepIndex: 0, steps: [] };
  boardChanged();
}

function lineupHtml(items) {
  return (items || []).map((value) => chipHtml(value)).join("");
}

function pickCell(hero, byHero) {
  const entry = byHero[hero];
  if (!entry) return chipHtml(hero);
  const name = playerName(Number(entry.player.slice(1)));
  const lane = entry.lane ? LANES[entry.lane] : "";
  return `<span class="pick-cell">${chipHtml(hero, "", "", `${heroBySlug(hero).name}: ${name}${lane ? `, ${lane}` : ""}${entry.mastery ? ` (${MASTERY[entry.mastery]})` : ""}`)}<span class="pick-player level-${entry.mastery || 0}">${name}</span>${lane ? `<span class="pick-lane">${lane}</span>` : ""}</span>`;
}

function teamColumn(name, sideCls, bans, picks, remaining = [], assignment = []) {
  const byHero = Object.fromEntries(assignment.map((entry) => [entry.hero, entry]));
  const cells = (items) => items.map((hero) => pickCell(hero, byHero)).join("");
  const done = picks.filter((hero) => !remaining.includes(hero));
  const next = remaining.length ? `<div class="pick-next"><span>Still to pick</span><div class="found-icons">${cells(remaining)}</div></div>` : "";
  return `<div class="found-team ${sideCls}"><strong>${name}</strong>
    <div class="found-row"><span>Bans</span><div class="found-icons">${lineupHtml(bans)}</div></div>
    <div class="found-row"><span>Picks</span><div class="found-icons">${cells(done)}</div>${next}</div></div>`;
}

const DIAGNOSTIC_TEXT = {
  ban: (name) => `${name} weren't banned`,
  enemy_pick: (name) => `the enemy hadn't taken ${name}`,
  our_pick: (name) => `you weren't locked into ${name}`,
  hidden: (name) => `${name} weren't hidden`,
  roster: () => "your player pools were ignored",
};

function emptyResults(diagnostics = []) {
  const lines = diagnostics.map((item) => `<li>If ${DIAGNOSTIC_TEXT[item.constraint](item.hero ? heroBySlug(item.hero).name : "")}: <strong>${item.compositions_if_lifted}</strong> composition${item.compositions_if_lifted === 1 ? "" : "s"} fit</li>`).join("");
  return `<div class="empty-state">No pro composition fits this board.${lines ? `<ul class="blockers">${lines}</ul>` : ""}</div>`;
}

function recordBadge(candidate) {
  const { games, wins, losses } = candidate.record || { games: 1, wins: 0, losses: 0 };
  const single = candidate.metadata.won === true ? "Won" : candidate.metadata.won === false ? "Lost" : "";
  const label = games > 1 ? `Played ${games}x, ${wins}W-${losses}L` : single;
  return label ? `<span class="score record${games === 1 && single === "Lost" ? " lost" : ""}">${label}</span>` : "";
}

function similarGames(candidate) {
  const others = candidate.similar_games || [];
  if (!others.length) return "";
  const rows = others.map((game) => `<li>${[game.date, `${game.team} vs ${game.opponent}`, game.tournament].filter(Boolean).join(" | ")}${game.won === true ? " | won" : game.won === false ? " | lost" : ""}${game.source_url ? ` <a href="${game.source_url}" target="_blank" rel="noreferrer">source</a>` : ""}</li>`).join("");
  return `<details class="similar"><summary>${others.length} other game${others.length === 1 ? "" : "s"} with this composition</summary><ul>${rows}</ul></details>`;
}

function renderResults(candidates, diagnostics) {
  $("#results").innerHTML = candidates.length ? candidates.map((candidate) => {
    const meta = candidate.metadata;
    const stale = meta.age_days != null && meta.age_days > 365;
    return `<article class="result-card">
      <div class="result-top"><div><div class="result-title">${meta.tournament} | Game ${meta.game_number ?? "?"}</div><div class="result-meta">${[meta.date, meta.patch, meta.stage].filter(Boolean).join(" | ")}${stale ? ` <span class="stale" title="Older than a year before the newest game in the catalog. Heroes may have changed since.">older draft</span>` : ""}</div></div><div class="scores">${recordBadge(candidate)}${candidate.roster_fit != null ? `<span class="score roster">Roster ${Math.round(candidate.roster_fit * 100)}%</span>` : ""}</div></div>
      <div class="found-picks">${teamColumn(meta.matched_team || "Your team", sideClass(state.simulation.side), candidate.our_bans || [], candidate.our_picks || candidate.composition || [], candidate.remaining_picks || [], candidate.assignment || [])}${teamColumn(meta.opponent_team || "Opponent", sideClass(oppositeSide(state.simulation.side)), candidate.opponent_bans || [], candidate.opponent_picks || candidate.opponent_composition || [])}</div>
      ${similarGames(candidate)}
      <div class="result-links"><a href="${meta.source_url}" target="_blank" rel="noreferrer">Source page</a>${meta.source_refs?.filter((ref) => ref.url !== meta.source_url).map((ref) => `<a href="${ref.url}" target="_blank" rel="noreferrer">${ref.source}</a>`).join("") || ""}</div>
    </article>`;
  }).join("") : emptyResults(diagnostics);
}

// Opening suggestions: flex picks while nothing is picked, bans whenever a ban is plausible next.
let suggestionTimer = null;
let suggestionRequestId = 0;

function renderSuggestions(data) {
  const box = $("#suggestions");
  const step = state.simulation.active ? state.simulation.steps[state.simulation.stepIndex] : null;
  const noPicks = !state.board.our_picks.length && !state.board.enemy_picks.length;
  const showFlex = data && noPicks && (!step || step.kind === "pick");
  const showBans = data && !state.simulation.complete && (!step || step.kind === "ban");
  box.hidden = !(showFlex || showBans);
  if (box.hidden) return;
  const chip = (item, kind) => `<button type="button" class="suggest-chip${item.team_fit === 0 && kind === "ban" ? " free" : ""}" data-suggest="${item.hero}" data-kind="${kind}" title="${item.reasons.join(". ")}"><img src="${iconUrl({ slug: item.hero })}" alt="${item.name}" draggable="false"><span>${item.name}</span><small>${kind === "ban" ? `B${Math.round(item.ban_rate * 100)}% P${Math.round(item.pick_rate * 100)}%` : item.lanes.map((lane) => LANES[lane]).join("/")}</small></button>`;
  const section = (title, hint, items, kind) => `<div class="suggest-block"><div class="strip-title"><span>${title}</span><span class="suggest-hint">${hint}</span></div><div class="suggest-row">${items.map((item) => chip(item, kind)).join("")}</div></div>`;
  box.innerHTML = (showFlex ? section("Flex picks", "Several lanes, often picked by pros. Hide the lane plan by taking them first.", data.flex_picks.slice(0, 8), "pick") : "")
    + (showBans ? section("Ban suggestions", "Pro ban/pick rate, flexibility, and whether your team plays the hero.", data.bans.slice(0, 8), "ban") : "");
}

$("#suggestions").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-suggest]");
  if (!chip) return;
  const hero = chip.dataset.suggest;
  if (!state.simulation.active) { selectHero(hero); return; }
  const step = state.simulation.steps[state.simulation.stepIndex];
  if (step && step.kind === chip.dataset.kind) handleHero(hero);
});

async function loadSuggestions() {
  const requestId = ++suggestionRequestId;
  try {
    const response = await request(`${API_BASE}/v1/suggestions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.board, excluded_heroes: state.hidden, player_pools: poolsPayload() }) });
    if (!response.ok) return;
    const data = await response.json();
    if (requestId === suggestionRequestId) renderSuggestions(data);
  } catch { /* suggestions are optional */ }
}

function scheduleSuggestions() {
  clearTimeout(suggestionTimer);
  suggestionRequestId += 1;
  suggestionTimer = setTimeout(loadSuggestions, 200);
}

// A single ban is enough to find compositions; no pick is required.
const hasDraftActions = () => state.board.bans.length || state.board.our_picks.length || state.board.enemy_picks.length;

async function search() {
  if (!hasDraftActions()) return;
  const requestId = ++searchRequestId;
  try {
    const response = await request(`${API_BASE}/v1/candidates`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...state.board, our_side: state.simulation.side, excluded_heroes: state.hidden, player_pools: poolsPayload(), limit: 50 }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || body.error || `Search failed (${response.status})`);
    if (requestId === searchRequestId) renderResults(body.candidates, body.diagnostics);
  } catch (error) { if (requestId === searchRequestId) $("#results").innerHTML = `<div class="empty-state error">${error.message}</div>`; }
}

function scheduleSearch() {
  scheduleSuggestions();
  clearTimeout(searchTimer);
  searchRequestId += 1;
  if (!hasDraftActions()) {
    $("#results").innerHTML = "";
    return;
  }
  searchTimer = setTimeout(search, 140);
}

async function loadHeroes() {
  markConnecting();
  const response = await request(`${API_BASE}/v1/heroes`);
  if (!response.ok) throw new Error(`Hero request failed (${response.status})`);
  state.heroes = await response.json();
  renderBoard(); renderHeroes(); renderPhase(); renderPools();
  scheduleSuggestions();
}

$("#hero-search").addEventListener("input", renderHeroes);
// Type a few letters and press Enter to take the first hero in the grid; Escape clears.
$("#hero-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { state.selected = null; $("#hero-search").value = ""; renderHeroes(); renderHeroActions(); }
  if (event.key !== "Enter") return;
  const first = document.querySelector("#hero-grid [data-hero]");
  if (first) handleHero(first.dataset.hero);
});
$("#undo-step").addEventListener("click", undoStep);
$("#lane-filter").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  laneFilter = button.dataset.filter;
  document.querySelectorAll("#lane-filter [data-filter]").forEach((el) => el.classList.toggle("on", el === button));
  renderHeroes();
});
$("#start-simulation").addEventListener("click", startSimulation);
$("#reset-simulation").addEventListener("click", resetSimulation);
$("#restore-hidden").addEventListener("click", () => { state.hidden = []; boardChanged(); });
$("#excluded").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-restore]");
  if (!chip) return;
  state.hidden = state.hidden.filter((hero) => hero !== chip.dataset.restore);
  boardChanged();
});
$("#simulation-format").addEventListener("change", () => { state.simulation.format = $("#simulation-format").value; renderBoard(); });
$("#team-side").addEventListener("change", () => { state.simulation.side = $("#team-side").value; renderBoard(); renderPhase(); });
renderPools(); renderPhase();
loadHeroes().catch((error) => { markDisconnected(); $("#results").innerHTML = `<div class="empty-state error">${error.message}</div>`; });
