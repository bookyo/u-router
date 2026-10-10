import { requestApi } from "./core.js";
const defaults = { baseUrl: "http://127.0.0.1:4444", apiKey: "" };
const ready = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own extension documents may invoke API operations; never arbitrary page URLs.
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL(""))
  )
    return false;
  (async () => {
    await ready;
    if (message.action === "closePanel") {
      if (sender.tab)
        await chrome.tabs.sendMessage(sender.tab.id, { action: "closePanel" });
      return {};
    }
    if (message.action === "openSettings") {
      await chrome.runtime.openOptionsPage();
      return {};
    }
    const settings = {
      ...defaults,
      ...(await chrome.storage.local.get(["baseUrl", "apiKey"])),
    };
    if (message.action === "summary")
      return {
        baseUrl: settings.baseUrl,
        authenticated: Boolean(settings.apiKey),
      };
    if (!["search", "create"].includes(message.action))
      throw new Error("不支持的操作");
    const origin = new URL(settings.baseUrl).origin + "/*";
    if (!(await chrome.permissions.contains({ origins: [origin] })))
      throw new Error("没有 API 访问权限，请打开设置并保存授权");
    return requestApi(settings, message.action, message.payload || {});
  })().then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
