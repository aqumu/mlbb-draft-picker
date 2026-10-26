// Run this file in the Playwriter page context after validating that the
// selected tournament's teams match the named event. Change TOURNAMENT before
// running it for another page.
const TOURNAMENT = {
  slug: "m6-world-championship",
  url: "https://www.mlbbanalytics.com/esports?tournament=m6-world-championship",
  liquipedia: "https://liquipedia.net/mobilelegends/M6_World_Championship",
};

if (!state.page) state.page = await context.newPage();
await state.page.goto(TOURNAMENT.url, { waitUntil: "domcontentloaded", timeout: 60000 });

const payload = await state.page.evaluate((tournament) => {
  const root = document.querySelectorAll("[x-data]")[1];
  const data = window.Alpine?.$data(root);
  const date = (value) => {
    const parsed = new Date(`${value} 00:00:00Z`);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
  };
  const matches = Array.from(data?.allMatches || []).flatMap((series) =>
    Array.from(series.games_data || []).map((game) => ({
      id: `mlbbanalytics-${tournament.slug}-${series.id}-${game.game}`,
      tournament: series.tournament_name,
      date: date(series.match_date),
      patch: null,
      stage: series.stage,
      series: `${series.team_a} vs ${series.team_b}`,
      game_number: game.game,
      duration: game.duration || null,
      winner: game.winner || null,
      teams: [
        { team: series.team_a, side: null, picks: Array.from(game.team_a_picks || []), bans: Array.from(game.team_a_bans || []) },
        { team: series.team_b, side: null, picks: Array.from(game.team_b_picks || []), bans: Array.from(game.team_b_bans || []) },
      ],
      source_url: location.href,
      source_refs: [
        { source: "mlbbanalytics", url: location.href },
        { source: "liquipedia", url: tournament.liquipedia },
      ],
    })),
  );
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    source: "mlbbanalytics",
    source_url: location.href,
    source_note: "Public playoff breakdown; page attributes tournament data to Liquipedia under CC-BY-SA 3.0.",
    matches,
  };
}, TOURNAMENT);

const fs = require("node:fs");
fs.mkdirSync("data/raw", { recursive: true });
const output = `data/raw/mlbbanalytics_${TOURNAMENT.slug.replaceAll("-", "_")}_playoffs.json`;
fs.writeFileSync(output, JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ output, matches: payload.matches.length }, null, 2));
