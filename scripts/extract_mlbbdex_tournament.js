// Run this file in the Playwriter page context. Change TOURNAMENT before
// running if a new MLBBDex tournament page is published.
const TOURNAMENT = {
  slug: "mpl-ph-season-18",
  url: "https://mlbbdex.com/en/esports/mpl-ph-season-18",
  liquipedia: "https://liquipedia.net/mobilelegends/MPL/Philippines/Season_18",
};

if (!state.page) state.page = await context.newPage();
await state.page.goto(TOURNAMENT.url, { waitUntil: "domcontentloaded", timeout: 60000 });

const payload = await state.page.evaluate((tournament) => {
  const section = [...document.querySelectorAll("section")].find(
    (s) => s.querySelector("h2")?.textContent?.trim() === "Latest drafts",
  );
  const patch = document.body.innerText.match(/(?:^|\n)PATCH\s*\n\s*([^\n]+)/i)?.[1]?.trim() || null;
  const parseTeam = (teamDiv) => {
    const teamP = teamDiv.children[0];
    const picksGroup = teamDiv.children[1];
    const bansGroup = teamDiv.children[2];
    return {
      team: teamP?.querySelector("span:nth-child(2)")?.textContent?.trim() || "",
      side: teamP?.querySelector(".sr-only")?.textContent?.replace(/[()]/g, "").trim() || null,
      picks: [...(picksGroup?.querySelectorAll("li[title]") || [])].map((el) => el.getAttribute("title")),
      bans: [...(bansGroup?.querySelectorAll("li[title]") || [])].map((el) => el.getAttribute("title")),
    };
  };
  const series = [...(section?.querySelectorAll(":scope > ol > li") || [])];
  const matches = series.flatMap((seriesLi, seriesIndex) => {
    const card = seriesLi.children[0];
    const seriesTitle = card?.querySelector(":scope > div > h3")?.textContent?.trim() || "";
    const dateText = card?.querySelector(":scope > div > p")?.innerText || "";
    const date = card?.querySelector("time")?.getAttribute("datetime")?.slice(0, 10) || null;
    const stage = dateText.split(/·/).slice(1).join("·").trim() || null;
    const games = [...(card?.querySelectorAll(":scope > ol > li") || [])];
    return games.map((gameLi, gameIndex) => {
      const parts = (gameLi.children[0]?.innerText || "").split(/·/).map((x) => x.trim());
      const winner = parts.slice(2).join("·").replace(/\s+wins$/, "").trim() || null;
      return {
        id: `${tournament.slug}-${seriesIndex + 1}-${gameIndex + 1}`,
        tournament: document.querySelector("h1")?.textContent?.trim() || document.title.split(":")[0],
        date,
        patch,
        stage,
        series: seriesTitle,
        game_number: gameIndex + 1,
        duration: parts[1] || null,
        winner,
        teams: [...gameLi.querySelectorAll(":scope > div")].map(parseTeam),
        source_url: location.href,
        source_refs: [
          { source: "mlbbdex", url: location.href },
          { source: "liquipedia", url: tournament.liquipedia },
        ],
      };
    });
  });
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    source: "mlbbdex",
    source_url: location.href,
    source_note: "Public tournament page; MLBBDex attributes tournament data to Liquipedia under CC-BY-SA 3.0.",
    matches,
  };
}, TOURNAMENT);

const fs = require("node:fs");
fs.mkdirSync("data/raw", { recursive: true });
const output = `data/raw/mlbbdex_${TOURNAMENT.slug.replaceAll("-", "_")}_latest.json`;
fs.writeFileSync(output, JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ output, matches: payload.matches.length }, null, 2));
