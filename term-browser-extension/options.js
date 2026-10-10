import { normalizeBaseUrl } from "./core.js";
const $ = (id) => document.getElementById(id);
const stored = await chrome.storage.local.get(["baseUrl", "apiKey"]);
$("base-url").value = stored.baseUrl || "http://127.0.0.1:4444";
$("api-key").value = stored.apiKey || "";
$("options-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.submitter;
  try {
    const baseUrl = normalizeBaseUrl($("base-url").value),
      apiKey = $("api-key").value.trim();
    // Request during the user's click, before any asynchronous storage work.
    const grant = chrome.permissions.request({
      origins: [new URL(baseUrl).origin + "/*"],
    });
    button.disabled = true;
    if (!(await grant)) throw new Error("未获得 API 访问权限，设置没有保存");
    await chrome.storage.local.set({ baseUrl, apiKey });
    $("base-url").value = baseUrl;
    $("status").textContent = "已保存，返回网页面板即可使用。";
    $("status").className = "success";
  } catch (error) {
    $("status").textContent = error.message;
    $("status").className = "error";
  } finally {
    button.disabled = false;
  }
};
