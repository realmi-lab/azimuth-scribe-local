"use strict";
window.ScribeVault = (() => {
  const byId = id => document.getElementById(id);
  let status = null, syncing = null, active = false, lastTouch = 0;
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
    const creating = !status.initialized;
    byId("vault-title").textContent = creating ? "암호화 보관함 만들기" : status.locking ? "작업을 마무리하고 잠그는 중…" : "보관함 잠금 해제";
    byId("vault-confirm-label").hidden = !creating;
    byId("vault-confirm").required = creating;
    byId("vault-password").minLength = creating ? 12 : 1;
    byId("vault-password").autocomplete = creating ? "new-password" : "current-password";
    byId("vault-submit").textContent = creating ? "보관함 만들고 기존 파일 암호화" : "비밀번호로 열기";
    byId("vault-submit").disabled = status.locking;
    byId("vault-native").hidden = !native() || creating;
    byId("vault-remember-label").hidden = !native();
    byId("vault-note").textContent = creating
      ? "Mac 로그인 암호와 별개의 비밀번호를 12자 이상 정하세요. 기존 파일은 암호화 복사본을 검증한 뒤 원본을 지웁니다. 비밀번호를 잊고 키체인도 사용할 수 없으면 복구할 수 없습니다."
      : "비밀번호 또는 Mac 앱의 본인 인증으로 보관함을 여세요. 녹음 중 임시 파일은 암호화 대상에서 제외됩니다.";
  }
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const response = await fetch("/api/vault/status", {cache: "no-store"});
      if (!response.ok) throw new Error("보관함 상태를 읽을 수 없습니다.");
      status = await response.json();
      render(); show(status.locked);
      return !status.locked;
    })();
    try { return await syncing; } finally { syncing = null; }
  }
  async function post(path, body = {}) {
    const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json", "X-Scribe-Request": "1"}, body: JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "보관함을 열 수 없습니다.");
    return result;
  }
  byId("vault-form").addEventListener("submit", async event => {
    event.preventDefault();
    let password = byId("vault-password").value;
    byId("vault-error").textContent = "";
    byId("vault-submit").disabled = true;
    try {
      if (!status) await sync();
      if (!status.initialized && password !== byId("vault-confirm").value) throw new Error("비밀번호 확인이 일치하지 않습니다.");
      const remember = byId("vault-remember").checked;
      const result = await post(status.initialized ? "/api/vault/unlock" : "/api/vault/setup", {password});
      bridge({action: "session", session: result.session, id: result.id, password: remember ? password : null});
      byId("vault-password").value = byId("vault-confirm").value = "";
      status = result;
      show(false);
    } catch (error) { byId("vault-error").textContent = error.message; }
    finally { password = ""; byId("vault-submit").disabled = false; }
  });
  byId("vault-native").onclick = () => bridge({action: "unlock"});
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
  window.addEventListener("vault-native-error", event => { byId("vault-error").textContent = event.detail; });
  return {sync, touch, bridge, requireUnlock: () => { show(true); }};
})();
