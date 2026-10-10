const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createServer } = require("node:http");
const { createApp } = require("../../term-lookup-api/src/app.js");
const playwright = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const extension = path.resolve(__dirname, "..");
const temporary = mkdtempSync(path.join(tmpdir(), "term-pocket-test-"));
const app = createApp({
  apiKey: "browser-test-key",
  databasePath: path.join(temporary, "terms.sqlite"),
});
const server = createServer((req, res) => {
  if (req.url.startsWith("/fixture")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url.includes("strict"))
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'",
      );
    res.end(
      "<!doctype html><title>Hostile styles fixture</title><style>*{font-size:50px!important;background:red!important}iframe{display:none!important}</style><h1>网页内容</h1>",
    );
  } else app(req, res);
});
let context;
(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  const artifacts = path.join(extension, "test-artifacts");
  mkdirSync(artifacts, { recursive: true });
  context = await playwright.chromium.launchPersistentContext(
    path.join(temporary, "profile"),
    {
      channel: "chromium",
      ...(process.env.CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.CHROMIUM_EXECUTABLE }
        : {}),
      headless: true,
      args: [
        "--disable-extensions-except=" + extension,
        "--load-extension=" + extension,
      ],
      viewport: { width: 1280, height: 900 },
    },
  );
  let worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const errors = [];
  context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
  const options = await context.newPage();
  await options.goto("chrome-extension://" + extensionId + "/options.html");
  await options.locator("#base-url").fill(baseUrl);
  await options.locator("button[type=submit]").click();
  await options.locator("#status.success").waitFor();
  const page = await context.newPage();
  await page.goto(baseUrl + "/fixture");
  const host = page.locator("#term-pocket-extension");
  await host.waitFor();
  const box = await host.boundingBox();
  assert.ok(
    Math.abs(box.y + box.height / 2 - 450) < 2,
    "launcher vertically centered",
  );
  const frameReady = page.waitForEvent("framenavigated", {
    predicate: (f) => f.url().includes("/panel.html"),
  });
  await page.mouse.click(box.x + 20, box.y + 30);
  const frame = await frameReady;
  await frame.locator("#connection").filter({ hasText: "匿名搜索" }).waitFor();
  // Use real keyboard activation inside the closed-shadow iframe; Playwright's
  // pointer hit testing cannot consistently resolve its closed-shadow owner.
  async function click(selector) {
    await page.bringToFront();
    await frame.locator(selector).focus();
    await page.keyboard.press("Enter");
  }
  await frame.locator("#query").fill("Example");
  await click("#search-form button");
  await frame.waitForFunction(
    () =>
      document.getElementById("status").textContent &&
      document.getElementById("status").textContent !== "正在搜索…",
  );
  console.log("Search status:", await frame.locator("#status").innerText());
  await frame.locator("#status").filter({ hasText: "没有匹配词条" }).waitFor();
  console.log("PASS: anonymous search, centered launcher, isolated iframe");
  await click("#add-tab");
  await frame.locator(".phrases").nth(0).fill("Example\nSample");
  await frame.locator(".phrases").nth(1).fill("示例");
  await frame
    .locator("body")
    .screenshot({ path: path.join(artifacts, "add-minimal-panel.png") });
  await click("#create");
  await frame.locator("#status.error").filter({ hasText: "API Key" }).waitFor();
  assert.equal(
    await frame.locator(".phrases").first().inputValue(),
    "Example\nSample",
  );
  await options.locator("#api-key").fill("browser-test-key");
  await options.locator("button[type=submit]").click();
  await frame
    .locator("#connection")
    .filter({ hasText: "已设置 Key" })
    .waitFor();
  await click("#add-language");
  await frame.locator(".language").nth(2).fill("ja");
  await frame.locator(".phrases").nth(2).fill("例\nサンプル");
  await click("#create");
  await frame.locator("#status.success").waitFor();
  assert.equal(await frame.locator(".phrases").first().inputValue(), "");
  await click("#search-tab");
  await frame.locator("#query").fill("Sample");
  await click("#search-form button");
  await frame.locator(".result").waitFor();
  assert.match(await frame.locator(".result").innerText(), /示例/);
  assert.match(await frame.locator(".result").innerText(), /サンプル/);
  console.log(
    "PASS: key required, preserve failed input, settings refresh, aliases + third language create/search",
  );
  await frame.locator("#query").fill("示例");
  assert.equal(await frame.locator("#source").inputValue(), "zh-Hans");
  await frame.locator("#query").fill("Example");
  assert.equal(
    await frame.locator("#source").inputValue(),
    "en",
    "automatic language switches back for English",
  );
  await frame.locator("#source").fill("ja");
  await frame.locator("#query").fill("例");
  assert.equal(
    await frame.locator("#source").inputValue(),
    "ja",
    "explicit source must not be overridden",
  );
  await click("#search-form button");
  await frame.locator(".result").waitFor();
  // The page cannot read extension-local secrets, even through a content script.
  assert.equal(
    await page.evaluate(
      () => document.querySelector("#term-pocket-extension").shadowRoot,
    ),
    null,
  );
  assert.equal(
    await page.evaluate(() =>
      document.body.innerText.includes("browser-test-key"),
    ),
    false,
  );
  const session = await context.newCDPSession(page);
  const worlds = [];
  session.on("Runtime.executionContextCreated", (event) =>
    worlds.push(event.context),
  );
  await session.send("Runtime.enable");
  const isolated = worlds.find(
    (world) =>
      world.auxData?.type === "isolated" &&
      world.origin === "chrome-extension://" + extensionId,
  );
  assert.ok(isolated, "extension content-script world found");
  const denied = await session.send("Runtime.evaluate", {
    contextId: isolated.id,
    expression: "chrome.storage.local.get('apiKey').then(()=>false,()=>true)",
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(
    denied.result.value,
    true,
    "content script must not read API Key storage",
  );
  await session.detach();
  await frame.locator("#source").fill("zh-Hans");
  await frame.locator("#query").fill("示例");
  await click("#search-form button");
  await frame.locator(".result").waitFor();
  await page.screenshot({ path: path.join(artifacts, "search-desktop.png") });
  await frame
    .locator("body")
    .screenshot({ path: path.join(artifacts, "search-panel.png") });
  await page.setViewportSize({ width: 320, height: 640 });
  const bounds = await frame.locator("body").boundingBox();
  assert.ok(bounds.width <= 320, "panel fits narrow viewport");
  await page.screenshot({ path: path.join(artifacts, "search-mobile.png") });
  await frame.locator("#query").press("Escape");
  assert.equal(
    await frame.evaluate(() => getComputedStyle(document.body).display),
    "flex",
  );
  assert.equal(await host.boundingBox().then((b) => b.width), 42);
  console.log(
    "PASS: Chinese input, narrow viewport, Escape close, closed shadow security",
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  const launch = await host.boundingBox();
  await page.mouse.click(launch.x + 20, launch.y + 30);
  await click("#add-tab");
  await page.screenshot({ path: path.join(artifacts, "add-desktop.png") });
  await frame
    .locator("body")
    .screenshot({ path: path.join(artifacts, "add-panel.png") });
  // Toolbar/standalone extension panel has the same UI; verify pointer actions too.
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + extensionId + "/panel.html");
  await popup
    .locator("#connection")
    .filter({ hasText: "已设置 Key" })
    .waitFor();
  await popup.locator("#query").fill("Example");
  await popup.locator("#search-form button").click();
  await popup.locator(".result").waitFor();
  for (let i = 0; i < 20; i++) {
    const seeded = await fetch(baseUrl + "/v2/terms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "browser-test-key",
      },
      body: JSON.stringify({
        translations: { en: ["Example"], "zh-Hans": ["示例" + i] },
      }),
    });
    assert.equal(seeded.status, 201);
  }
  await popup.locator("#search-form button").click();
  await popup
    .locator("#status")
    .filter({ hasText: "找到 21 个词条" })
    .waitFor();
  assert.equal(await popup.locator(".result").count(), 20);
  await popup.locator("#more-results").click();
  await popup.locator("#more-results").waitFor({ state: "hidden" });
  assert.equal(await popup.locator(".result").count(), 21);
  await popup.close();
  console.log("PASS: shared toolbar panel pointer interaction");
  const strict = await context.newPage();
  await strict.goto(baseUrl + "/fixture?strict");
  const strictHost = strict.locator("#term-pocket-extension");
  await strictHost.waitFor();
  const strictReady = strict.waitForEvent("framenavigated", {
    predicate: (f) => f.url().includes("/panel.html"),
  });
  const strictBox = await strictHost.boundingBox();
  await strict.mouse.click(strictBox.x + 20, strictBox.y + 30);
  const strictFrame = await strictReady;
  await strictFrame
    .locator("#connection")
    .filter({ hasText: "已设置 Key" })
    .waitFor();
  await strict.close();
  console.log(
    "PASS: strict frame-src CSP page, content-script storage denied, 21-result pagination",
  );
  // Anonymous quota is enforced by the real backend; the UI must surface Retry-After.
  await options.locator("#api-key").fill("");
  await options.locator("button[type=submit]").click();
  await frame.locator("#connection").filter({ hasText: "匿名搜索" }).waitFor();
  for (let i = 0; i < 20; i++)
    await fetch(baseUrl + "/v2/terms?q=Example&from=en");
  await click("#search-tab");
  await frame.locator("#query").fill("Example");
  await frame.locator("#source").fill("en");
  await click("#search-form button");
  await frame
    .locator("#status.error")
    .filter({ hasText: "秒后重试" })
    .waitFor();
  console.log("PASS: real anonymous rate-limit error");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: no browser JavaScript errors; screenshots saved in test-artifacts",
  );
})()
  .catch(async (error) => {
    console.error(error);
    if (context) {
      for (const p of context.pages()) {
        for (const f of p.frames()) {
          console.log(
            "DEBUG",
            f.url(),
            await f
              .locator("body")
              .innerText({ timeout: 2000 })
              .catch(() => ""),
          );
        }
      }
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (context) await context.close();
    await new Promise((resolve) => server.close(resolve));
    app.close();
    rmSync(temporary, { recursive: true, force: true });
  });
