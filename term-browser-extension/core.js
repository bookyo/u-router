export function normalizeBaseUrl(value) {
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("API 地址必须是无账号、查询参数的 HTTP/HTTPS 地址");
  return url.href.replace(/\/+$/, "");
}

export function languageTag(value) {
  try {
    return (
      Intl.getCanonicalLocales(value.trim())[0] ||
      (() => {
        throw 0;
      })()
    );
  } catch {
    throw new Error("请输入有效的语言代码，例如 en、zh-Hans、ja");
  }
}

export function buildTranslations(rows) {
  if (rows.length > 50) throw new Error("最多添加 50 种语言");
  const translations = Object.create(null);
  for (const row of rows) {
    const language = languageTag(row.language);
    if (Object.hasOwn(translations, language))
      throw new Error("语言重复：" + language);
    const seen = new Set();
    const phrases = row.text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => {
        const key = s.normalize("NFKC").toLocaleLowerCase("en-US");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (!phrases.length) throw new Error(language + " 的译名不能为空");
    if (phrases.length > 50 || phrases.some((s) => s.length > 256))
      throw new Error("每种语言最多 50 个译名，每个不超过 256 字符");
    translations[language] = phrases;
  }
  if (!translations.en || !translations["zh-Hans"])
    throw new Error("至少填写 en 和 zh-Hans");
  return { ...translations };
}

export async function requestApi(settings, action, payload, fetcher = fetch) {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (
    ["read", "update"].includes(action) &&
    payload.expectedBaseUrl !== undefined &&
    base !== normalizeBaseUrl(payload.expectedBaseUrl)
  )
    throw new Error("API 地址已变更，请恢复原地址，或取消编辑后重新读取词条");
  const headers = { Accept: "application/json" };
  const apiKey = settings.apiKey?.trim();
  if (apiKey) headers["X-API-Key"] = apiKey;
  let url = base + "/v2/terms";
  const init = {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  };
  if (action === "search") {
    if (!payload.q?.trim()) throw new Error("请输入搜索内容");
    url +=
      "?" +
      new URLSearchParams({
        q: payload.q.trim(),
        from: languageTag(payload.from),
        limit: "20",
        offset: String(payload.offset || 0),
      });
  } else if (action === "read" || action === "update") {
    if (!Number.isSafeInteger(payload.id) || payload.id < 1)
      throw new Error("词条 ID 无效");
    url += "/" + payload.id;
    if (action === "update") {
      if (!apiKey) throw new Error("编辑需要 API Key，请先打开设置");
      init.method = "PATCH";
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({
        translations: buildTranslations(payload.rows || []),
      });
    }
  } else if (action === "create") {
    if (!apiKey) throw new Error("添加需要 API Key，请先打开设置");
    init.method = "POST";
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({
      translations: buildTranslations(payload.rows || []),
    });
  } else throw new Error("不支持的操作");
  let response;
  try {
    response = await fetcher(url, init);
  } catch (error) {
    throw new Error(
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "请求超时；写入结果可能已保存，请先搜索确认，不要重复提交"
        : "无法连接 API，请检查地址、服务和访问权限",
    );
  }
  const data = await response.json().catch(() => null);
  if (response.status === 429)
    throw new Error(
      "匿名搜索次数已用完，请在 " +
        (Number(response.headers.get("Retry-After")) || 60) +
        " 秒后重试，或设置有效 API Key",
    );
  if (response.status === 401)
    throw new Error("API Key 无效或未设置，请检查设置");
  if (!response.ok)
    throw new Error(
      data?.message ||
        "请求失败（" + response.status + "）；添加失败时请先搜索确认",
    );
  if (
    !data ||
    (action === "search" && !Array.isArray(data.items)) ||
    (["create", "read", "update"].includes(action) &&
      (!Number.isSafeInteger(data.id) || data.id < 1)) ||
    (["read", "update"].includes(action) && data.id !== payload.id)
  )
    throw new Error("API 返回了无效数据，请检查地址");
  return data;
}
