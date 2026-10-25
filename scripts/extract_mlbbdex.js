const url = "https://mlbbdex.com/en/esports/msc-2026";
if (!state.page || state.page.url() !== url) {
  state.page = await context.newPage();
  await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
}
const matches = await state.page.evaluate(() => {
  const section = [...document.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent?.trim() === "Latest drafts");
  const series = [...(section?.querySelectorAll(":scope > ol > li") || [])];
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
  return series.flatMap((seriesLi, seriesIndex) => {
    const card = seriesLi.children[0];
    const seriesTitle = card?.querySelector(":scope > div > h3")?.textContent?.trim() || "";
    const dateText = card?.querySelector(":scope > div > p")?.innerText || "";
    const date = card?.querySelector("time")?.getAttribute("datetime")?.slice(0, 10) || null;
    const stage = dateText.split("·").slice(1).join("·").trim() || null;
    const games = [...(card?.querySelectorAll(":scope > ol > li") || [])];
    return games.map((gameLi, gameIndex) => {
      const info = gameLi.children[0]?.innerText || "";
      const parts = info.split("·").map((x) => x.trim());
      const winner = parts.slice(2).join("·").replace(/\s+wins$/, "").trim() || null;
      const teams = [...gameLi.querySelectorAll(":scope > div")].map(parseTeam);
      return {
        id: `msc-2026-${seriesIndex + 1}-${gameIndex + 1}`,
        tournament: "MLBB Mid Season Cup 2026",
        date,
        stage,
        series: seriesTitle,
        game_number: gameIndex + 1,
        duration: parts[1] || null,
        winner,
        teams,
        source_url: location.href,
        source_refs: [
          { source: "mlbbdex", url: location.href },
          { source: "liquipedia", url: "https://liquipedia.net/mobilelegends/MSC/2026" },
        ],
      };
    });
  });
});
const payload = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  source: "mlbbdex",
  source_url: url,
  source_note: "Public tournament page; MLBBDex attributes tournament data to Liquipedia under CC-BY-SA 3.0.",
  matches,
};
const fs = require("node:fs");
fs.mkdirSync("data/raw", { recursive: true });
fs.writeFileSync("data/raw/mlbbdex_msc_2026_latest.json", JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ matches: matches.length, first: matches[0], output: "data/raw/mlbbdex_msc_2026_latest.json" }, null, 2));
