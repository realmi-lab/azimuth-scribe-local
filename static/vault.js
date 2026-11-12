"use strict";
window.ScribeVault = (() => {
  const byId = id => document.getElementById(id);
  let status = null, syncing = null, active = false, lastTouch = 0, authenticating = false;
  const native = () => window.webkit?.messageHandlers?.scribeVault;
  function bridge(data) { native()?.postMessage(data); }
  function show(locked) {
    const changed = active === locked;
    active = !locked;
    document.body.classList.toggle("vault-locked", locked);
    byId("vault-gate").hidden = !locked;
    for (const selector of [".workspace", ".menu-bar", "#panel-options"]) {
      const item = document.querySelector(selector);
      if (item) item.inert = locked;
    }
    if (locked) {
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      if (changed) window.dispatchEvent(new Event("vault-locked"));
    } else if (changed) window.dispatchEvent(new Event("vault-unlocked"));
    byId("vault-lock").hidden = locked;
  }
  function render() {
    const inMacApp = !!native(), migrating = status.initialized && status.auth_mode !== "macos";
    byId("vault-title").textContent = !inMacApp ? "Mac 앱에서 인증하세요" : status.locking ? "작업을 마무리하고 잠그는 중…" : migrating ? "Mac 본인 인증으로 전환" : status.initialized ? "보관함 잠금 해제" : "Mac 인증으로 보관함 시작";
    byId("vault-note").textContent = !inMacApp
      ? "녹음과 메모는 Mac 앱에서 Touch ID 또는 Mac 로그인 암호로 인증한 뒤 확인할 수 있습니다."
      : migrating ? "한 번의 Mac 본인 인증으로 기존 키체인 연결을 전환합니다. 기존 녹음과 메모는 유지됩니다."
      : "Touch ID 또는 Mac 로그인 암호로 암호화된 녹음과 메모를 여세요.";
    byId("vault-touchid").hidden = byId("vault-mac-password").hidden = !inMacApp;
    byId("vault-touchid").disabled = byId("vault-mac-password").disabled = status.locking || authenticating;
    byId("vault-open-app").hidden = inMacApp;
    byId("vault-auth-note").textContent = authenticating ? "macOS 인증 창에서 본인 인증을 완료해 주세요."
      : "Mac 로그인 암호는 macOS 인증 창에서만 입력합니다. 별도 앱 비밀번호는 사용하지 않습니다.";
  }
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const response = await fetch("/api/vault/status", {cache: "no-store"});
      if (!response.ok) throw new Error("보관함 상태를 읽을 수 없습니다.");
      status = await response.json();
      if (!status.locked) authenticating = false;
      render(); show(status.locked);
      return !status.locked;
    })();
    try { return await syncing; } finally { syncing = null; }
  }
  async function post(path) {
    const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json", "X-Scribe-Request": "1"}, body: "{}"});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "보관함 요청을 완료하지 못했습니다.");
    return result;
  }
  for (const [id, method] of [["vault-touchid", "touchid"], ["vault-mac-password", "password"]]) {
    byId(id).onclick = () => {
      if (!native() || authenticating || !status || status.locking) return;
      byId("vault-error").textContent = ""; authenticating = true; render();
      bridge({action: "authenticate", method});
    };
  }
  byId("vault-lock").onclick = async () => {
    try {
      await window.flushBeforeVaultLock?.();
      await post("/api/vault/lock");
      bridge({action: "locked"});
      await sync();
    } catch (error) { byId("vault-error").textContent = error.message; }
  };
  async function touch() {
    if (!active || Date.now() - lastTouch < 20000) return;
    lastTouch = Date.now();
    try { await post("/api/vault/touch"); } catch { await sync(); }
  }
  for (const type of ["keydown", "pointerdown", "input"]) document.addEventListener(type, touch, {passive: true});
  window.addEventListener("vault-native-error", event => {
    authenticating = false; byId("vault-error").textContent = event.detail; if (status) render();
  });
  return {sync, touch, bridge, requireUnlock: () => { show(true); }};
})();
