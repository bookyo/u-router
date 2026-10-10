(() => {
  const id = "term-pocket-extension";
  if (document.getElementById(id)) return;
  const host = document.createElement("div");
  host.id = id;
  host.style.cssText =
    "all:initial!important;position:fixed!important;right:0!important;top:50%!important;transform:translateY(-50%)!important;z-index:2147483647!important;display:block!important;";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{color-scheme:light}button{font:600 14px system-ui;cursor:pointer;color:#fff;background:#244fc5;border:1px solid #5477dd;border-radius:14px 0 0 14px;width:42px;height:68px;box-shadow:0 4px 18px #152b4333}button:focus-visible{outline:3px solid #16a6a2;outline-offset:3px}iframe{display:none;width:min(390px,calc(100vw - 16px));height:min(620px,calc(100dvh - 24px));border:1px solid #dce5f0;border-radius:18px 0 0 18px;box-shadow:0 12px 50px #152b4333;background:#f8fbff}iframe.open{display:block}button[hidden]{display:none}`;
  const button = document.createElement("button");
  button.textContent = "词";
  button.title = "搜索 / 添加多语言词条";
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-expanded", "false");
  let frame;
  const close = () => {
    if (frame) frame.classList.remove("open");
    button.hidden = false;
    button.setAttribute("aria-expanded", "false");
    button.focus();
  };
  button.addEventListener("click", () => {
    if (!frame) {
      frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("panel.html");
      frame.title = "多语言词条面板";
      root.append(frame);
    }
    frame.classList.add("open");
    button.hidden = true;
    button.setAttribute("aria-expanded", "true");
    frame.focus();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "closePanel") close();
  });
  root.append(style, button);
  document.documentElement.append(host);
})();
