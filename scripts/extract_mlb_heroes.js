const url = "https://mlbbdex.com/api/v1/heroes";
state.page = await context.newPage();
await state.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
const body = await state.page.locator("body").innerText();
const parsed = JSON.parse(body);
const payload = {
  schema_version: 1,
  captured_at: new Date().toISOString(),
  source: "mlbbdex",
  source_url: url,
  source_note: "Public MLBBDex hero API; credit and CC-BY-SA attribution travel with the response.",
  data: parsed,
};
const fs = require("node:fs");
fs.mkdirSync("data/raw", { recursive: true });
fs.writeFileSync("data/raw/mlbbdex_heroes.json", JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ output: "data/raw/mlbbdex_heroes.json", total: parsed.total, sample: parsed.data?.slice(0, 2) }, null, 2));
