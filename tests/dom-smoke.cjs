// In-memory DOM checks. This does not launch or control a web browser.
// NODE_PATH=/path/to/node_modules node tests/dom-smoke.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn, execFile} = require("node:child_process");
const run = require("node:util").promisify(execFile);
const {JSDOM, VirtualConsole} = require("jsdom");
const root = path.resolve(__dirname, "..");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-dom-"));
const base = "http://127.0.0.1:8767";
const log = fs.openSync(path.join(folder, "server.log"), "w");
const env = {...process.env, SCRIBE_DATA_DIR: folder, SCRIBE_PORT: "8767"};
const child = spawn(path.join(root, ".venv/bin/python"), [path.join(root, "tests/native-fixture.py"), "serve"], {
  env, stdio: ["ignore", log, log]
});
let dom, authCookie = "";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, limit = 10000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timeout: ${message}`);
}
async function readState() { return (await fetch(base + "/api/state", {headers: {Cookie: authCookie}})).json(); }
async function main() {
  await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "test server readiness");
  const errors = [], downloads = [];
  const console = new VirtualConsole();
  console.on("jsdomError", e => errors.push(e));
  dom = new JSDOM(fs.readFileSync(path.join(root, "static/index.html"), "utf8"), {
    url: base, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console
  });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.fetch = async (url, options = {}) => {
    const response = await fetch(new URL(url, base), {...options, headers: {...options.headers, Cookie: authCookie}});
    const cookie = response.headers.get("set-cookie");
    if (cookie) authCookie = cookie.split(";")[0];
    return response;
  };
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.HTMLAnchorElement.prototype.click = function() { downloads.push(this.href); };
  w.addEventListener("error", e => errors.push(e.error));
  const copied = [];
  Object.defineProperty(w.navigator, "clipboard", {value: {writeText: async value => copied.push(value)}});
  w.eval(["vault.js", "app.js", "history.js", "panel.js"].map(name => fs.readFileSync(path.join(root, "static", name), "utf8")).join("\n"));
  await until(() => $("vault-title").textContent.includes("Mac 앱"), "browser requires Mac app");
  assert.equal(d.body.classList.contains("vault-locked"), true);
  assert.equal(d.querySelectorAll('input[type="password"]').length, 0);
  assert.equal($("vault-touchid").hidden, true);
  assert.equal($("vault-open-app").hidden, false);
  assert.equal((await fetch(base + "/api/state")).status, 423);
  assert.equal((await fetch(base + "/api/vault/setup", {method:"POST", headers:{"X-Scribe-Request":"1"}})).status, 410);
  const bridgeMessages = [];
  let cancelNext = true;
  // Simulate the already-authenticated boundary only in a disposable fixture.
  // The production controller's LocalAuthentication is checked on the Mac.
  w.webkit = {messageHandlers:{scribeVault:{postMessage: async message => {
    bridgeMessages.push(message);
    if (message.action === "export") { downloads.push(new URL(message.url, base).href); return; }
    if (message.action !== "authenticate") return;
    if (cancelNext) {
      cancelNext = false;
      w.dispatchEvent(new w.CustomEvent("vault-native-error", {detail:"인증을 취소했습니다. 보관함은 잠겨 있습니다."}));
      return;
    }
    try {
      const result = await run(path.join(root, ".venv/bin/python"), [path.join(root, "tests/native-fixture.py"), "unlock"], {env});
      authCookie = "scribe_vault=" + JSON.parse(result.stdout).session;
      w.dispatchEvent(new w.Event("hashchange"));
    } catch (error) { w.dispatchEvent(new w.CustomEvent("vault-native-error", {detail:error.message})); }
  }}}};
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => !$("vault-touchid").hidden, "native authentication controls");
  assert.equal($("vault-open-app").hidden, true);
  $("vault-touchid").click();
  await until(() => $("vault-error").textContent.includes("취소"), "authentication cancel keeps vault locked");
  assert.equal($("vault-gate").hidden, false);
  assert.equal((await fetch(base + "/api/state")).status, 423);
  $("vault-mac-password").click();
  await until(() => $("vault-gate").hidden, "Mac authentication opens vault");
  assert.deepEqual(bridgeMessages.filter(m => m.action === "authenticate").map(m => m.method), ["touchid", "password"]);
  process.stdout.write("PASS: browser gate, no app password, native auth choices and cancel/retry flow\n");
  await until(() => $("app-status").textContent.includes("모델"), "initial DOM render");
  assert.equal($("file-count").textContent, "0개");
  assert.equal($("prompt-select").options.length, 4);
  assert.equal($("stt-button").disabled, true);
  process.stdout.write("PASS: initial UI state, empty file list, four prompt choices\n");
  const realFetch = w.fetch;
  w.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).startsWith("/api/state")) {
      const snapshot = await response.json();
      snapshot.runtime.job = {id: "visible-cancel", type: "summary", status: "running", message: "요약 중"};
      return {ok: true, status: 200, json: async () => snapshot};
    }
    return response;
  };
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => $("stt-button").textContent.includes("중단"), "history exposes summary cancellation");
  assert.equal($("stt-button").disabled, false);
  assert.equal($("summary-button").disabled, false);
  w.fetch = realFetch; w.dispatchEvent(new w.Event("hashchange"));
  await until(() => $("stt-button").textContent.includes("받아쓰기"), "idle controls restored");
  const wav = Buffer.alloc(32044);
  wav.write("RIFF", 0); wav.writeUInt32LE(32036, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  const upload = new FormData(); upload.append("files", new Blob([wav], {type: "audio/wav"}), "회의자료.wav");
  const added = await (await fetch(base + "/api/files", {method: "POST", headers: {Cookie: authCookie, "X-Scribe-Request": "1"}, body: upload})).json();
  const fileId = added.files[0].id;
  await fetch(base + "/api/text", {method: "PATCH", headers: {Cookie: authCookie, "X-Scribe-Request": "1", "Content-Type": "application/json"}, body: JSON.stringify({file_id: fileId, transcript: "카드 원문에만 있는 검색단어", summary: "녹음별 요약 내용"})});
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => $("file-list").querySelector(".card-text")?.textContent.includes("검색단어"), "recording card render");
  const card = $("file-list").querySelector(".history-card"), audioNode = card.querySelector("audio");
  assert.ok(audioNode.src.includes("/api/download/recordings/"));
  $("history-search").value = "검색단어"; $("history-search").dispatchEvent(new w.Event("input"));
  assert.equal(card.hidden, false);
  $("history-search").value = "검색결과없는단어"; $("history-search").dispatchEvent(new w.Event("input"));
  assert.equal(card.hidden, true); assert.equal($("no-search-results").hidden, false);
  assert.equal($("stt-button").disabled, true, "hidden selections cannot start a filtered batch");
  $("history-search").value = ""; $("history-search").dispatchEvent(new w.Event("input"));
  card.querySelector('[data-tab="summary"]').click();
  assert.equal(card.querySelector(".card-text").textContent, "녹음별 요약 내용");
  card.querySelector(".card-copy").click(); await until(() => copied.length === 1, "card summary copy");
  assert.equal(copied[0], "녹음별 요약 내용");
  const selectCard = card.querySelector('input[type="checkbox"]'); selectCard.checked = false;
  selectCard.dispatchEvent(new w.Event("change"));
  await until(async () => !(await readState()).files[0].selected, "card selection saved");
  await until(() => $("file-count").textContent === "1개", "selection render");
  assert.equal(card.querySelector("audio"), audioNode, "polling preserves the player element");
  assert.equal(card.querySelectorAll(".summary-choices button").length, 4);
  card.querySelector(".card-open").click();
  await until(() => !$("detail-view").hidden, "recording editor opens");
  assert.equal($("summary").value, "녹음별 요약 내용");
  $("tab-transcript").click(); $("transcript").value = "이 녹음만 수정합니다.";
  $("transcript").dispatchEvent(new w.Event("input", {bubbles:true}));
  await until(async () => (await readState()).files[0].transcript === "이 녹음만 수정합니다.", "scoped recording autosave");
  assert.equal((await readState()).transcript, "");
  $("nav-notes").click();
  await until(() => $("detail-title").textContent === "전체 메모" && $("transcript").value === "", "global memo stays separate");
  process.stdout.write("PASS: searchable history cards, scoped editing, preview/copy, player persistence and reprocessing choices\n");

  $("transcript").value = "이번 주 금요일 오후 두 시에 제품 시연을 진행합니다.";
  $("transcript").dispatchEvent(new w.Event("input", {bubbles: true}));
  await until(async () => (await readState()).transcript === $("transcript").value, "text autosave");
  assert.equal($("transcript-count").textContent, `${$("transcript").value.length}자`);
  assert.equal($("save-transcript").disabled, false);
  process.stdout.write("PASS: editable transcript, live character count and autosave\n");

  d.querySelector('[data-action="settings"]').click();
  await until(() => $("settings-dialog").open, "preferences opens");
  assert.equal($("settings-form").elements.namedItem("language").value, "ko");
  $("settings-form").elements.namedItem("temperature").value = "0.3";
  $("settings-form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
  await until(async () => (await readState()).settings.temperature === 0.3, "preferences save");
  await until(() => !$("settings-dialog").open, "preferences closes");
  w.location.hash = "settings";
  await until(() => $("settings-dialog").open, "native settings deep link opens");
  assert.equal(w.location.hash, "");
  $("settings-dialog").close();
  process.stdout.write("PASS: native settings deep link opens preferences and clears fragment\n");
  d.querySelector('[data-action="prompts"]').click();
  $("new-prompt-name").value = "사용자 테스트"; $("add-prompt").click();
  $("prompt-editor").value = "대화에서 확정한 일정만 정리하세요.";
  $("prompts-form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
  await until(async () => (await readState()).prompts["사용자 테스트"] === "대화에서 확정한 일정만 정리하세요.", "custom prompt save");
  await until(() => [...$("prompt-select").options].some(option => option.value === "사용자 테스트"), "prompt list updates");
  process.stdout.write("PASS: preferences and custom prompt editor event handling\n");

  $("save-transcript").click(); assert.equal($("save-dialog").open, true);
  $("save-format").value = "md"; $("save-plain").checked = true;
  $("save-form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => downloads.length === 1, "export click");
  assert.equal(await (await fetch(downloads[0], {headers: {Cookie: authCookie}})).text(), $("transcript").value);
  assert.ok(downloads[0].endsWith(".md"));
  $("help-button").click(); assert.ok($("info-content").textContent.includes("localhost")); $("info-dialog").close();
  $("licenses-button").click(); assert.ok($("info-content").textContent.includes("faster-whisper")); $("info-dialog").close();
  $("vault-lock").click();
  await until(() => !$("vault-gate").hidden, "vault manual lock");
  assert.equal(d.querySelectorAll('input[type="password"]').length, 0);
  assert.equal($("vault-touchid").disabled, false);
  assert.equal($("transcript").value, "");
  assert.equal($("prompt-editor").value, "");
  assert.equal($("file-list").children.length, 0);
  assert.equal($("history-search").value, "");
  assert.equal((await fetch(base + "/api/state", {headers:{Cookie:authCookie}})).status, 423);
  $("vault-touchid").click();
  await until(() => $("vault-gate").hidden && $("transcript").value.includes("제품 시연"), "unlock restores encrypted text");
  process.stdout.write("PASS: manual lock clears private UI and native reauthentication restores encrypted text\n");
  assert.deepEqual(errors.map(e => e.message), []);
  process.stdout.write("PASS: Markdown save/download, help, notices and no JavaScript runtime errors\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; }).finally(async () => {
  dom?.window.close(); child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  fs.closeSync(log); fs.rmSync(folder, {recursive: true, force: true});
});
