import { buildTranslations, languageTag } from "./core.js";
const $ = (id) => document.getElementById(id);
if (window === window.top) document.body.classList.add("popup");
const call = async (action, payload) => {
  const result = await chrome.runtime.sendMessage({ action, payload });
  if (!result?.ok)
    throw new Error(result?.error || "扩展连接已断开，请刷新页面");
  return result.data;
};
const status = (text, kind = "") => {
  $("status").textContent = text;
  $("status").className = kind;
};
async function refresh() {
  try {
    const s = await call("summary");
    $("connection").textContent =
      (s.authenticated
        ? "已设置 Key · 有效时不限流"
        : "匿名搜索 · 每 IP 20 次 / 分钟") +
      " · " +
      s.baseUrl;
  } catch (e) {
    status(e.message, "error");
  }
}
refresh();
window.addEventListener("focus", refresh);
chrome.storage.onChanged.addListener(refresh);
for (const name of ["search", "add"])
  $(name + "-tab").onclick = () => {
    for (const tab of ["search", "add"]) {
      $(tab + "-tab").classList.toggle("active", tab === name);
      $(tab + "-tab").setAttribute("aria-pressed", String(tab === name));
      $(tab + "-section").hidden = tab !== name;
    }
    status("");
    if (name === "search") $("query").focus();
  };
$("settings").onclick = () =>
  call("openSettings").catch((e) => status(e.message, "error"));
const close = () => {
  if (window === window.top) window.close();
  else call("closePanel").catch(() => {});
};
$("close").onclick = close;
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") close();
});
let rowId = 0;
function addRow(language = "", text = "", required = false) {
  if ($("language-rows").children.length >= 50) {
    status("最多添加 50 种语言", "error");
    return;
  }
  const id = "translation-" + ++rowId,
    row = document.createElement("div");
  row.className = "language-row";
  const head = document.createElement("div");
  head.className = "row-head";
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = required
    ? language === "en"
      ? "英文 *"
      : "简体中文 *"
    : "语言代码";
  const lang = document.createElement("input");
  lang.value = language;
  lang.placeholder = "例如 ja";
  lang.setAttribute("list", "languages");
  lang.setAttribute("aria-label", "语言代码");
  lang.required = true;
  lang.readOnly = required;
  lang.className = "language";
  head.append(label, lang);
  if (!required) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "移除";
    remove.onclick = () => row.remove();
    head.append(remove);
  }
  const phrases = document.createElement("textarea");
  phrases.id = id;
  phrases.className = "phrases";
  phrases.value = text;
  phrases.required = true;
  phrases.placeholder =
    language === "en"
      ? "Example\nSample"
      : language === "zh-Hans"
        ? "示例\n样例"
        : "每行一个译名";
  row.append(head, phrases);
  $("language-rows").append(row);
  if (!required) lang.focus();
}
addRow("en", "", true);
addRow("zh-Hans", "", true);
$("add-language").onclick = () => addRow();
function render(items, append = false) {
  if (!append) $("results").replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "result";
    const heading = document.createElement("div");
    heading.className = "result-heading";
    heading.textContent = "#" + item.id + " · " + (item.type || "term");
    card.append(heading);
    for (const [lang, values] of Object.entries(item.translations || {})) {
      const line = document.createElement("div");
      line.className = "translation";
      const tag = document.createElement("code");
      tag.textContent = lang;
      const value = document.createElement("span");
      value.textContent = Array.isArray(values)
        ? values.join(" / ")
        : String(values);
      line.append(tag, value);
      card.append(line);
    }
    $("results").append(card);
  }
}
let searchPayload = null,
  busy = false;
async function search(append = false) {
  if (busy) return;
  try {
    const payload = append
      ? { ...searchPayload, offset: $("results").children.length }
      : {
          q: $("query").value.trim(),
          from: languageTag($("source").value),
          offset: 0,
        };
    busy = true;
    $("search-form").querySelector("button").disabled = true;
    $("more-results").disabled = true;
    status("正在搜索…");
    const data = await call("search", payload);
    searchPayload = payload;
    render(data.items, append);
    $("more-results").hidden = $("results").children.length >= data.total;
    status(
      data.total
        ? "找到 " + data.total + " 个词条"
        : "没有匹配词条，可切换到「添加词条」创建。",
    );
  } catch (e) {
    status(e.message, "error");
  } finally {
    busy = false;
    $("search-form").querySelector("button").disabled = false;
    $("more-results").disabled = false;
  }
}
$("search-form").onsubmit = (e) => {
  e.preventDefault();
  search();
};
$("more-results").onclick = () => search(true);
let automaticSource = true;
$("source").addEventListener("input", () => {
  automaticSource = false;
});
$("query").addEventListener("input", () => {
  if (automaticSource)
    $("source").value = /[\u3400-\u9fff]/.test($("query").value)
      ? "zh-Hans"
      : "en";
});
$("add-form").onsubmit = async (e) => {
  e.preventDefault();
  if ($("create").disabled) return;
  try {
    const rows = [...document.querySelectorAll(".language-row")].map((row) => ({
      language: row.querySelector(".language").value,
      text: row.querySelector(".phrases").value,
    }));
    buildTranslations(rows);
    $("create").disabled = true;
    status("正在创建，请勿重复提交…");
    const data = await call("create", { rows });
    status("已创建词条 #" + data.id + "，可切换到搜索查看。", "success");
    document.querySelectorAll(".phrases").forEach((el) => (el.value = ""));
  } catch (e) {
    status(e.message, "error");
  } finally {
    $("create").disabled = false;
  }
};
