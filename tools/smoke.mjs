// A quick look at the game's own page, small enough for Playwright's software renderer in WSL
// (the playtests need the real graphics card to keep time): the start board, taking the gun,
// firing, the end card with the high score entry, and that ?party=1 on a page nobody mounted
// changes nothing. The browser is headless and muted and is closed whatever happens.
// Run the local server first (npm run dev), then: node tools/smoke.mjs [--base=...]
import { BASE, openBrowser } from "./browser.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith("--" + k + "=")) ?? "--" + k + "=" + d).split("=").slice(1).join("=");
const base = opt("base", BASE);
const problems = [];
const check = (ok, what) => {
  console.log((ok ? "ok   " : "FAIL ") + what);
  if (!ok) problems.push(what);
};

// A small picture: the software renderer draws a few frames a second, and the round's clock runs with the frames.
const browser = await openBrowser({ win: false, width: 640, height: 360 });
try {
  const errors = [];
  const open = async (query) => {
    const page = await (await browser.newContext()).newPage();
    page.on("console", (m) => m.type() === "error" && !/WebSocket|ERR_/.test(m.text()) && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(base + "?quality=low" + query);
    await page.waitForFunction(() => window.__cab?.session, null, { timeout: 90000 });
    return page;
  };
  const state = (page) =>
    page.evaluate(() => ({
      mode: window.__cab.mode,
      hosted: document.body.classList.contains("hosted"),
      start: !document.getElementById("start").hidden,
      battle: !!document.getElementById("battle").offsetParent,
      lobby: window.__cab.lobby.root instanceof HTMLElement,
      shots: window.__cab.session.sims[0]?.shots ?? 0,
    }));

  for (const [name, query] of [["the page on its own", ""], ["the page with ?party=1 and nobody hosting it", "&party=1"]]) {
    const page = await open(query);
    const first = await state(page);
    check(first.mode === "attract" && first.start && first.battle && !first.hosted && first.lobby, `${name}: the house plays behind the start board, with Play alone and Battle with friends`);
    await page.click("#start-solo");
    await page.waitForFunction(() => window.__cab.mode === "solo" && window.__cab.session.time() > 0.2, null, { timeout: 120000 });
    for (let i = 0; i < 2; i++) {
      const before = (await state(page)).shots;
      await page.mouse.click(260 + i * 60, 170);
      // The lever takes half a second of the round's time to cock: wait for the shot, however slow the frames.
      await page.waitForFunction((n) => window.__cab.session.sims[0].shots > n, before, { timeout: 60000 }).catch(() => {});
      await page.waitForFunction(() => window.__cab.session.canFire(), null, { timeout: 60000 }).catch(() => {});
    }
    const played = await state(page);
    check(played.mode === "solo" && !played.start && played.shots >= 2, `${name}: Play alone starts a round and a click fires (${played.shots} corks from 2 clicks)`);
    await page.close();
  }

  const end = await open("&state=end&score=99999");
  await end.waitForSelector("#card:not([hidden])", { timeout: 30000 });
  const card = await end.evaluate(() => ({ title: document.getElementById("card-title").textContent, form: !document.getElementById("initials").hidden, again: document.getElementById("again").textContent }));
  check(card.form && card.again === "Play again", `the end card asks for three letters for the high score board ("${card.title}")`);
  const board = await end.request.get(new URL("/api/party/scores/cork-and-bell", base).href);
  check(board.ok() && Array.isArray((await board.json()).top), "the high score board answers");
  await end.close();

  check(errors.length === 0, "no page reported an error" + (errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""));
} catch (err) {
  console.log("FAIL the run stopped: " + (err?.stack ?? err));
  problems.push("the run stopped");
} finally {
  await browser.close();
}
console.log(problems.length ? `\n${problems.length} problem(s):\n- ` + problems.join("\n- ") : "\nAll good.");
process.exit(problems.length ? 1 : 0);
