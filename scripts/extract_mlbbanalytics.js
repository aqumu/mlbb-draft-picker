const url = "https://www.mlbbanalytics.com/esports?tournament=msc-2026";
if (!state.page || state.page.url() !== url) {
  state.page = await context.newPage();
  await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await state.page.waitForTimeout(3000);
}
const viewButton = state.page.getByRole("button", { name: /View Playoff Games/ });
if (await viewButton.count()) await viewButton.click();
await state.page.waitForTimeout(500);
const expandButton = state.page.getByRole("button", { name: /Expand All Games/ });
if (await expandButton.count()) await expandButton.click();
await state.page.waitForTimeout(700);

const payload = await state.page.evaluate(() => {
  const h = [...document.querySelectorAll("h2")].find((el) => el.innerText?.includes("Playoff Series"));
  const box = h?.closest(".bg-white");
  const seriesContainer = box?.children[2];
  const cards = [...(seriesContainer?.children || [])].filter((el) => el.className.includes("bg-zinc-50"));
  const parseTeam = (block) => {
    const team = (block.children[0]?.innerText?.trim() || "").replace(/\s+Picks & Bans$/, "");
    const picks = [...(block.children[1]?.querySelectorAll("img[alt]") || [])].map((img) => img.getAttribute("alt"));
    const bans = [...(block.children[2]?.querySelectorAll("img[alt]") || [])].map((img) => img.getAttribute("alt"));
    return { team, picks, bans };
  };
  const parsePlayers = (lineup) => {
    const rows = [...(lineup?.querySelectorAll(":scope > div") || [])].slice(1);
    return rows.map((row) => {
      const text = row.innerText.split("\n").map((x) => x.trim()).filter(Boolean);
      return { role: text[0] || null, hero: text[1] || null, player: text[2] || null, kda: text[3] || null };
    }).filter((row) => row.hero);
  };
  const matches = [];
  for (const [seriesIndex, card] of cards.entries()) {
    const headerLines = (card.children[0]?.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const stage = headerLines[0] || null;
    const tournament = headerLines[1] || "MLBB Mid Season Cup 2026";
    const dateLine = headerLines.find((x) => /^·\s/.test(x)) || "";
    const date = dateLine.replace(/^·\s*/, "") || null;
    const body = card.children[1];
    const gamesContainer = [...(body?.children || [])].find((el) => el.className.includes("space-y-3"));
    const games = [...(gamesContainer?.children || [])].filter((el) => el.className.includes("bg-zinc-50"));
    for (const [gameIndex, game] of games.entries()) {
      const header = game.children[0]?.innerText || "";
      const lines = header.split("\n").map((x) => x.trim()).filter(Boolean);
      const gameNumber = Number((lines.find((x) => /^Game \d+/.test(x)) || "").match(/\d+/)?.[0] || gameIndex + 1);
      const duration = lines.find((x) => /^Duration:/.test(x))?.replace(/^Duration:\s*/, "") || null;
      const kills = lines.find((x) => /^Kills:/.test(x))?.replace(/^Kills:\s*/, "") || null;
      const winner = lines.find((x) => /^Winner:/.test(x))?.replace(/^Winner:\s*/, "") || null;
      const teams = [...(game.children[3]?.children || [])].map(parseTeam);
      matches.push({
        id: `msc-2026-analytics-${seriesIndex + 1}-${gameNumber}`,
        tournament,
        stage,
        date,
        series_index: seriesIndex + 1,
        game_number: gameNumber,
        duration,
        kills,
        winner,
        teams,
        source_url: location.href,
        source_refs: [
          { source: "mlbbanalytics", url: location.href },
          { source: "liquipedia", url: "https://liquipedia.net/mobilelegends/MSC/2026" },
        ],
      });
    }
  }
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    source: "mlbbanalytics",
    source_url: location.href,
    source_note: "Public playoff breakdown; page attributes tournament data to Liquipedia under CC-BY-SA 3.0.",
    matches,
  };
});
const fs = require("node:fs");
fs.mkdirSync("data/raw", { recursive: true });
fs.writeFileSync("data/raw/mlbbanalytics_msc_2026_playoffs.json", JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ matches: payload.matches.length, first: payload.matches[0], output: "data/raw/mlbbanalytics_msc_2026_playoffs.json" }, null, 2));
