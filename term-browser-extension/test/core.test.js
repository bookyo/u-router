import test from "node:test";
test("edit cannot write to a different API address", async () => {
  let calls = 0;
  await assert.rejects(
    requestApi(
      { baseUrl: "http://server-b.test", apiKey: "key" },
      "update",
      {
        id: 7,
        expectedBaseUrl: "http://server-a.test",
        rows: [
          { language: "en", text: "Example" },
          { language: "zh-Hans", text: "示例" },
        ],
      },
      async () => {
        calls++;
        return new Response('{"id":7}');
      },
    ),
    /API 地址已变更/,
  );
  assert.equal(calls, 0);
});
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { buildTranslations, normalizeBaseUrl, requestApi } from "../core.js";
test("edit loads exact ID and PATCH sends only multilingual names", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        id: 7,
        translations: { en: ["Example"], "zh-Hans": ["示例"] },
      }),
    );
  };
  const settings = { baseUrl: "http://localhost:4444", apiKey: "secret" };
  await requestApi(settings, "read", { id: 7 }, fetcher);
  await requestApi(
    settings,
    "update",
    {
      id: 7,
      rows: [
        { language: "en", text: "Example\nSample" },
        { language: "zh-Hans", text: "示例" },
        { language: "ja", text: "例" },
      ],
    },
    fetcher,
  );
  assert.equal(calls[0].url, "http://localhost:4444/v2/terms/7");
  assert.equal(calls[1].init.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    translations: {
      en: ["Example", "Sample"],
      "zh-Hans": ["示例"],
      ja: ["例"],
    },
  });
});
test("edit requires key, validates ID and preserves errors", async () => {
  const rows = [
    { language: "en", text: "Example" },
    { language: "zh-Hans", text: "示例" },
  ];
  await assert.rejects(
    requestApi({ baseUrl: "http://localhost:4444" }, "update", { id: 1, rows }),
    /API Key/,
  );
  for (const id of [-1, 0, "../settings", 1.5])
    await assert.rejects(
      requestApi({ baseUrl: "http://localhost:4444", apiKey: "k" }, "update", {
        id,
        rows,
      }),
      /ID/,
    );
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444", apiKey: "k" },
      "update",
      { id: 1, rows },
      async () => new Response("{}", { status: 404 }),
    ),
    /不存在|404/,
  );
});
test("manifest minimum supports dynamic viewport units and all entry points exist", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.ok(Number(manifest.minimum_chrome_version) >= 108);
  for (const file of [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.content_scripts.flatMap((script) => script.js),
  ])
    assert.ok(existsSync(new URL("../" + file, import.meta.url)), file);
});

test("minimal multilingual payload and newline aliases", () => {
  assert.deepEqual(
    buildTranslations([
      { language: "en", text: " Example\nSample\nExample " },
      { language: "zh-hans", text: "示例" },
    ]),
    { en: ["Example", "Sample"], "zh-Hans": ["示例"] },
  );
});
test("reject missing required language, duplicate languages and invalid tags", () => {
  assert.throws(
    () => buildTranslations([{ language: "en", text: "Example" }]),
    /zh-Hans/,
  );
  assert.throws(
    () =>
      buildTranslations([
        { language: "en", text: "Example" },
        { language: "EN", text: "Test" },
        { language: "zh-Hans", text: "示例" },
      ]),
    /重复/,
  );
  assert.throws(
    () => buildTranslations([{ language: "bad_tag", text: "x" }]),
    /语言/,
  );
});
test("reject empty and too long phrases", () => {
  assert.throws(
    () =>
      buildTranslations([
        { language: "en", text: "" },
        { language: "zh-Hans", text: "示例" },
      ]),
    /不能为空/,
  );
  assert.throws(
    () =>
      buildTranslations([
        { language: "en", text: "x".repeat(257) },
        { language: "zh-Hans", text: "示例" },
      ]),
    /256/,
  );
});
test("normalize API address without credentials or query", () => {
  assert.equal(
    normalizeBaseUrl(" http://localhost:4444/ "),
    "http://localhost:4444",
  );
  for (const url of [
    "file:///tmp/a",
    "https://user:pass@example.com",
    "https://example.com/?key=x",
  ])
    assert.throws(() => normalizeBaseUrl(url));
});
test("search encodes query and uses optional key", async () => {
  let call;
  const fetcher = async (url, init) => {
    call = { url, init };
    return new Response(JSON.stringify({ items: [], total: 0 }), {
      status: 200,
    });
  };
  await requestApi(
    { baseUrl: "http://localhost:4444", apiKey: "" },
    "search",
    { q: "a&中", from: "en" },
    fetcher,
  );
  assert.equal(new URL(call.url).searchParams.get("q"), "a&中");
  assert.equal(call.init.headers["X-API-Key"], undefined);
  await requestApi(
    { baseUrl: "http://localhost:4444", apiKey: "secret" },
    "search",
    { q: "x", from: "en" },
    fetcher,
  );
  assert.equal(call.init.headers["X-API-Key"], "secret");
});
test("creation needs key and never retries", async () => {
  let calls = 0;
  await assert.rejects(
    requestApi({ baseUrl: "http://localhost:4444" }, "create", {}, async () => {
      calls++;
    }),
    /API Key/,
  );
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444", apiKey: "key" },
      "create",
      {
        rows: [
          { language: "en", text: "Example" },
          { language: "zh-Hans", text: "示例" },
        ],
      },
      async () => {
        calls++;
        return new Response("{}", { status: 500 });
      },
    ),
  );
  assert.equal(calls, 1);
});
test("429 and invalid keys provide actionable errors", async () => {
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444" },
      "search",
      { q: "x", from: "en" },
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "35" } }),
    ),
    /35 秒/,
  );
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444", apiKey: "wrong" },
      "search",
      { q: "x", from: "en" },
      async () => new Response("{}", { status: 401 }),
    ),
    /API Key/,
  );
});
test("reject malformed success data and unknown actions", async () => {
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444" },
      "search",
      { q: "x", from: "en" },
      async () => new Response("<html>", { status: 200 }),
    ),
    /无效数据/,
  );
  await assert.rejects(
    requestApi({ baseUrl: "http://localhost:4444" }, "delete", {}, async () => {
      throw new Error("must not fetch");
    }),
    /不支持/,
  );
});
test("timeout does not silently retry creation", async () => {
  let calls = 0;
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444", apiKey: "key" },
      "create",
      {
        rows: [
          { language: "en", text: "Example" },
          { language: "zh-Hans", text: "示例" },
        ],
      },
      async () => {
        calls++;
        throw new DOMException("timeout", "TimeoutError");
      },
    ),
    /先搜索确认/,
  );
  assert.equal(calls, 1);
});
test("reject language and phrase count overflow", () => {
  assert.throws(
    () =>
      buildTranslations(
        Array.from({ length: 51 }, () => ({ language: "en", text: "Example" })),
      ),
    /50/,
  );
  assert.throws(
    () =>
      buildTranslations([
        {
          language: "en",
          text: Array.from({ length: 51 }, (_, i) => "word" + i).join("\n"),
        },
        { language: "zh-Hans", text: "示例" },
      ]),
    /50/,
  );
});
test("creation success requires a real term identifier", async () => {
  await assert.rejects(
    requestApi(
      { baseUrl: "http://localhost:4444", apiKey: "key" },
      "create",
      {
        rows: [
          { language: "en", text: "Example" },
          { language: "zh-Hans", text: "示例" },
        ],
      },
      async () => new Response("{}", { status: 201 }),
    ),
    /无效数据/,
  );
});
