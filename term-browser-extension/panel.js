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
function showSection(name) {
  for (const tab of ["search", "add"]) {
    $(tab + "-tab").classList.toggle("active", tab === name);
    $(tab + "-tab").setAttribute("aria-pressed", String(tab === name));
    $(tab + "-section").hidden = tab !== name;
  }
  status("");
  if (name === "search") $("query").focus();
}
for (const name of ["search", "add"])
  $(name + "-tab").onclick = () => showSection(name);
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
let editingId = null,
  editingBaseUrl = null,
  loadingEdit = false,
  createDraft = null,
  resultItems = [];
const getRows = () =>
  [...document.querySelectorAll(".language-row")].map((row) => ({
    language: row.querySelector(".language").value,
    text: row.querySelector(".phrases").value,
  }));
function replaceRows(rows) {
  $("language-rows").replaceChildren();
  for (const row of rows)
    addRow(row.language, row.text, ["en", "zh-Hans"].includes(row.language));
}
function formBusy(busy) {
  for (const el of document.querySelectorAll(
    "#add-form input, #add-form textarea, #add-form button, nav button",
  ))
    el.disabled = busy;
}
function editLabels() {
  $("add-tab").textContent = editingId ? "编辑 #" + editingId : "添加词条";
  $("create").textContent = editingId ? "保存修改" : "创建多语言词条";
  $("cancel-edit").hidden = !editingId;
  $("form-intro").textContent = editingId
    ? "编辑词条 #" + editingId + " · 修改名称、别名与语言"
    : "让同一个意思，拥有不同语言的名字。";
  $("form-hint").textContent = editingId
    ? "每行一个译名，第一行是首选名称。保存将替换该词条的名称集合；移除额外语言会删除其译名。英文与简体中文必填，其他字段保持不变。"
    : "每行一个译名，可填写多个同义词。英文与简体中文必填；相同内容再次提交也会创建新词条。";
}
async function beginEdit(id) {
  if (loadingEdit || $("create").disabled) return;
  if (editingId) {
    if (editingId === id) showSection("add");
    else
      status(
        "正在编辑词条 #" +
          editingId +
          "，请先取消编辑，再选择其它词条（未保存的输入会保留）。",
        "error",
      );
    return;
  }
  loadingEdit = true;
  formBusy(true);
  status("正在读取词条 #" + id + "…");
  try {
    const settings = await call("summary");
    const data = await call("read", { id, expectedBaseUrl: settings.baseUrl });
    const rows = Object.entries(data.translations).map(([language, names]) => ({
      language,
      text: names.join("\n"),
    }));
    buildTranslations(rows);
    if (!editingId) createDraft = getRows();
    editingId = data.id;
    editingBaseUrl = settings.baseUrl;
    // Put the required languages first without changing alias order.
    replaceRows([
      { language: "en", text: data.translations.en.join("\n") },
      { language: "zh-Hans", text: data.translations["zh-Hans"].join("\n") },
      ...rows.filter((row) => !["en", "zh-Hans"].includes(row.language)),
    ]);
    editLabels();
    showSection("add");
    $("language-rows").querySelector("textarea").focus();
  } catch (error) {
    status(error.message, "error");
  } finally {
    loadingEdit = false;
    formBusy(false);
  }
}
$("cancel-edit").onclick = () => {
  editingId = null;
  editingBaseUrl = null;
  replaceRows(
    createDraft || [
      { language: "en", text: "" },
      { language: "zh-Hans", text: "" },
    ],
  );
  createDraft = null;
  editLabels();
  showSection("search");
};
function render(items, append = false) {
  resultItems = append ? [...resultItems, ...items] : items;
  if (!append) $("results").replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "result";
    const heading = document.createElement("div");
    heading.className = "result-heading";
    heading.textContent = "#" + item.id + " · " + (item.type || "term");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit-term";
    edit.textContent = "编辑";
    edit.setAttribute("aria-label", "编辑词条 #" + item.id);
    edit.onclick = () => beginEdit(item.id);
    heading.append(edit);
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
    const rows = getRows();
    buildTranslations(rows);
    formBusy(true);
    status(
      editingId
        ? "正在保存词条 #" + editingId + "…"
        : "正在创建，请勿重复提交…",
    );
    const data = await call(editingId ? "update" : "create", {
      rows,
      ...(editingId ? { id: editingId, expectedBaseUrl: editingBaseUrl } : {}),
    });
    if (editingId) {
      render(resultItems.map((item) => (item.id === data.id ? data : item)));
      status("已保存词条 #" + data.id + "，别名与语言已更新。", "success");
    } else {
      status("已创建词条 #" + data.id + "，可切换到搜索查看。", "success");
      document.querySelectorAll(".phrases").forEach((el) => (el.value = ""));
    }
  } catch (e) {
    status(e.message, "error");
  } finally {
    formBusy(false);
  }
};
