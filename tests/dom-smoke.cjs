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
  assert.equal($("history-count").textContent, "0");
  assert.equal($("empty-files").hidden, false);
  assert.equal($("pending-bar").hidden, true);
  assert.deepEqual([...$("prompt-select").options].map(option => option.value), ["일반 요약", "회의록"]);
  // One primary action per record replaced the old batch controls.
  for (const id of ["select-all", "delete-button", "file-count", "confirm-dialog"]) assert.equal($(id), null, id);
  assert.equal(d.querySelector('.app-sidebar [data-action="replace"]'), null);
  assert.equal($("transcript-panel").querySelector("[data-open-replace]"), null);
  assert.equal(d.querySelectorAll("[data-open-replace]").length, 1);
  process.stdout.write("PASS: initial UI state, empty list, two prompt choices, no batch controls\n");

  const wav = Buffer.alloc(32044);
  wav.write("RIFF", 0); wav.writeUInt32LE(32036, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  const send = {Cookie: authCookie, "X-Scribe-Request": "1"};
  const addFile = async name => {
    const upload = new FormData(); upload.append("files", new Blob([wav], {type: "audio/wav"}), name);
    return (await (await fetch(base + "/api/files", {method: "POST", headers: send, body: upload})).json()).files[0];
  };
  const setText = body => fetch(base + "/api/text", {method: "PATCH", headers: {...send, "Content-Type": "application/json"}, body: JSON.stringify(body)});
  const cardOf = id => $("file-list").querySelector(`[data-id="${id}"]`);
  const fileId = (await addFile("회의자료.wav")).id;
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => cardOf(fileId), "new recording card");
  const card = cardOf(fileId);
  assert.equal(card.querySelector(".card-title").textContent, "회의자료", "audio extension is not shown");
  assert.equal(card.querySelector(".card-run").hidden, false);
  assert.ok(card.querySelector(".card-run").textContent.includes("요약하기"));
  assert.ok(card.querySelector(".card-text").classList.contains("placeholder"));
  assert.equal(card.querySelector("audio"), null, "the list has no audio players");

  // "요약하기" on a card is one request; the server transcribes first when needed.
  const requests = [];
  const realFetch = w.fetch;
  w.fetch = async (url, options = {}) => {
    if (String(url) === "/api/summary") requests.push(JSON.parse(options.body));
    return realFetch(url, options);
  };
  card.querySelector(".card-run").click();
  await until(() => requests.length === 1, "card summary request");
  assert.deepEqual(requests[0], {prompt: "일반 요약", file_id: fileId});
  await until(() => !$("toast").hidden && $("toast").textContent.includes("음성 인식 모델"), "missing speech model is explained");
  w.fetch = realFetch;

  // A running job shows its stop control on that record only.
  const secondFile = await addFile("다른회의.wav");
  w.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).startsWith("/api/state")) {
      const snapshot = await response.json();
      snapshot.runtime.job = {id: "visible-cancel", type: "summary", status: "running", message: "요약하는 중…", progress: null, target: fileId, stage: "summary"};
      return {ok: true, status: 200, json: async () => snapshot};
    }
    return response;
  };
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => card.querySelector(".card-run").textContent.includes("중단"), "running record exposes cancellation");
  assert.equal(card.querySelector(".card-run").disabled, false);
  assert.ok(card.querySelector(".file-status").textContent.includes("요약하는 중"));
  await until(() => cardOf(secondFile.id), "second recording loaded");
  assert.equal(cardOf(secondFile.id).querySelector(".card-run").disabled, true, "other records wait");
  assert.ok(cardOf(secondFile.id).querySelector(".card-run").textContent.includes("요약하기"));
  assert.equal($("pending-bar").hidden, true, "no batch offer while working");
  w.fetch = realFetch; w.dispatchEvent(new w.Event("hashchange"));
  await until(() => card.querySelector(".card-run").textContent.includes("요약하기") && !card.querySelector(".card-run").disabled, "idle controls restored");
  await until(() => !$("pending-bar").hidden, "two unsummarised records offer a batch");
  assert.ok($("pending-count").textContent.includes("2개"));
  w.fetch = async (url, options = {}) => {
    if (String(url) === "/api/summary") requests.push(JSON.parse(options.body));
    return realFetch(url, options);
  };
  $("summarize-all").click();
  await until(() => requests.length === 2, "batch summary request");
  assert.deepEqual(requests[1], {prompt: "일반 요약", ids: [fileId, secondFile.id]});
  w.fetch = realFetch;
  process.stdout.write("PASS: one-click summary per record, scoped stop control and batch for leftovers\n");

  // Calendar view: the same records by day, coloured by how many were recorded.
  const now = new Date(), pad = value => String(value).padStart(2, "0");
  const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  assert.equal($("calendar-panel").hidden, true);
  $("view-calendar").click();
  await until(async () => (await readState()).view === "calendar", "view preference saved");
  assert.equal($("calendar-panel").hidden, false);
  assert.equal($("view-calendar").getAttribute("aria-pressed"), "true");
  assert.equal($("calendar-title").textContent, `${now.getFullYear()}년 ${now.getMonth() + 1}월`);
  const todayCell = () => d.querySelector(`.calendar-day[data-day="${todayKey}"]`);
  assert.equal(d.querySelectorAll(".calendar-day").length, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  assert.ok(todayCell().classList.contains("level-2"), "two recordings today");
  assert.ok(todayCell().classList.contains("today"));
  assert.equal(todayCell().querySelector(".calendar-count").textContent, "2");
  assert.equal(todayCell().getAttribute("aria-pressed"), "true");
  assert.ok($("day-title").textContent.includes("녹음 2개"));
  assert.equal(card.hidden, false);
  const otherDay = [...d.querySelectorAll(".calendar-day")].find(cell => cell.dataset.day !== todayKey);
  otherDay.click();
  assert.equal(otherDay.getAttribute("aria-pressed"), "true");
  assert.ok(otherDay.classList.contains("level-0"));
  assert.equal(card.hidden, true, "another day hides today's records");
  assert.equal($("day-empty").hidden, false); assert.equal($("no-search-results").hidden, true);
  otherDay.dispatchEvent(new w.KeyboardEvent("keydown", {key: "ArrowDown", bubbles: true}));
  const moved = new Date(otherDay.dataset.day + "T00:00:00"); moved.setDate(moved.getDate() + 7);
  assert.equal(d.querySelector('.calendar-day[aria-pressed="true"]').dataset.day, `${moved.getFullYear()}-${pad(moved.getMonth() + 1)}-${pad(moved.getDate())}`, "arrow keys move by day and week");
  $("calendar-next").click();
  assert.notEqual($("calendar-title").textContent, "");
  $("calendar-today").click();
  assert.equal(todayCell().getAttribute("aria-pressed"), "true"); assert.equal(card.hidden, false);
  $("history-search").value = "검색결과없는단어"; $("history-search").dispatchEvent(new w.Event("input"));
  assert.ok(todayCell().classList.contains("level-0"), "the heatmap follows the search");
  $("history-search").value = ""; $("history-search").dispatchEvent(new w.Event("input"));
  $("view-list").click();
  await until(async () => (await readState()).view === "list", "list preference saved");
  assert.equal($("calendar-panel").hidden, true); assert.equal($("day-title").hidden, true); assert.equal(card.hidden, false);
  process.stdout.write("PASS: calendar heatmap by day, day selection, keyboard and saved view preference\n");

  await setText({file_id: fileId, transcript: "카드 원문에만 있는 검색단어", summary: "## 주요 내용\n- 녹음별 요약 내용"});
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => card.querySelector(".card-text").textContent === "녹음별 요약 내용", "card previews the summary without headings or Markdown marks");
  assert.equal(card.querySelector(".card-run").hidden, true, "a summarised record needs no action");
  assert.equal($("pending-bar").hidden, true);
  $("history-search").value = "검색단어"; $("history-search").dispatchEvent(new w.Event("input"));
  assert.equal(card.hidden, false);
  $("history-search").value = "검색결과없는단어"; $("history-search").dispatchEvent(new w.Event("input"));
  assert.equal(card.hidden, true); assert.equal($("no-search-results").hidden, false);
  $("history-search").value = ""; $("history-search").dispatchEvent(new w.Event("input"));

  // Opening a record shows its summary first, editable in place.
  card.querySelector(".card-main").click();
  await until(() => !$("detail-view").hidden, "record opens");
  assert.equal($("detail-title").textContent, "회의자료");
  assert.equal($("tab-summary").getAttribute("aria-selected"), "true");
  assert.equal($("summary-panel").hidden, false);
  assert.equal($("summary").value, "## 주요 내용\n- 녹음별 요약 내용");
  assert.ok($("detail-audio").src.includes("/api/download/recordings/"));
  assert.ok($("summary-button").textContent.includes("다시 요약"));
  assert.equal($("copy-button").hidden, false);
  $("copy-button").click(); await until(() => copied.length === 1, "summary copy");
  assert.equal(copied[0], "## 주요 내용\n- 녹음별 요약 내용");
  $("summary").value = "녹음별 요약 내용"; $("summary").dispatchEvent(new w.Event("input", {bubbles: true}));
  await until(async () => (await readState()).files[0].summary === "녹음별 요약 내용", "summary edited in place is saved");
  $("tab-transcript").click();
  assert.equal($("transcript-panel").hidden, false); assert.equal($("summary-panel").hidden, true);
  assert.equal($("clear-button").hidden, true, "clearing is only offered in the shared memo");
  $("transcript").value = "이 녹음만 수정합니다.";
  $("transcript").dispatchEvent(new w.Event("input", {bubbles: true}));
  await until(async () => (await readState()).files[0].transcript === "이 녹음만 수정합니다.", "scoped recording autosave");
  assert.equal((await readState()).transcript, "");
  $("detail-title").textContent = "  주간   회의  "; $("detail-title").dispatchEvent(new w.Event("blur"));
  await until(async () => (await readState()).files[0].name === "주간 회의", "rename in place");
  await until(() => card.querySelector(".card-title").textContent === "주간 회의", "renamed card");
  assert.equal((await fetch(base + "/api/download/recordings/" + (await readState()).files[0].stored_name, {headers: {Cookie: authCookie}})).headers.get("content-type"), "audio/x-wav");
  process.stdout.write("PASS: summary-first record page, in-place editing, copy and rename\n");

  await setText({file_id: secondFile.id, transcript: "다른 녹음 원문", summary: "녹음별 요약 내용"});
  await setText({summary: "녹음별 요약 내용"});
  w.dispatchEvent(new w.Event("hashchange"));
  await until(() => cardOf(secondFile.id).querySelector(".card-run").hidden, "second recording summarised");
  $("tab-summary").click(); $("summary-replace").click();
  assert.equal($("replace-dialog").open, true);
  assert.ok($("replace-scope").textContent.includes("주간 회의"));
  d.querySelector(".replace-find").value = "요약";
  d.querySelector(".replace-to").value = "수정된 요약";
  $("replace-form").dispatchEvent(new w.Event("submit", {bubbles:true,cancelable:true}));
  await until(() => !$("replace-dialog").open && $("toast").querySelector(".toast-action"), "summary correction and undo ready");
  let corrected = await readState();
  assert.equal(corrected.files.find(f => f.id === fileId).summary, "녹음별 수정된 요약 내용");
  assert.equal(corrected.files.find(f => f.id === fileId).transcript, "이 녹음만 수정합니다.");
  assert.equal(corrected.files.find(f => f.id === secondFile.id).summary, "녹음별 요약 내용");
  assert.equal(corrected.summary, "녹음별 요약 내용");
  // Undo after changing records must still address only the original summary.
  $("back-to-history").click();
  await until(() => !$("history-view").hidden, "history before switching summaries");
  assert.equal($("detail-audio").hasAttribute("src"), false, "leaving a record releases its audio");
  await w.openRecord(secondFile.id);
  await until(() => $("detail-title").textContent.includes("다른회의"), "native hand-off opens a record");
  $("summary").value = "다른 요약의 새 편집"; $("summary").dispatchEvent(new w.Event("input", {bubbles:true}));
  await until(async () => (await readState()).files.find(f => f.id === secondFile.id).summary === "다른 요약의 새 편집", "other summary edit saved");
  $("toast").querySelector(".toast-action").click();
  await until(async () => (await readState()).files.find(f => f.id === fileId).summary === "녹음별 요약 내용", "scoped undo");
  corrected = await readState();
  assert.equal(corrected.files.find(f => f.id === secondFile.id).summary, "다른 요약의 새 편집");
  assert.equal(corrected.summary, "녹음별 요약 내용");
  assert.equal(corrected.files.find(f => f.id === fileId).transcript, "이 녹음만 수정합니다.");
  process.stdout.write("PASS: summary-only correction, explicit record scope and scoped undo\n");
  $("nav-notes").click();
  await until(() => $("detail-title").textContent === "전체 메모" && $("transcript").value === "", "global memo stays separate");
  assert.equal($("summary").value, "녹음별 요약 내용");
  assert.equal($("detail-title").getAttribute("contenteditable"), "false");
  $("tab-transcript").click();
  assert.equal($("stt-button").hidden, true); assert.equal($("detail-audio").hidden, true);
  process.stdout.write("PASS: searchable record list and separate shared memo\n");

  $("transcript").value = "이번 주 금요일 오후 두 시에 제품 시연을 진행합니다.";
  $("transcript").dispatchEvent(new w.Event("input", {bubbles: true}));
  await until(async () => (await readState()).transcript === $("transcript").value, "text autosave");
  assert.equal($("transcript-count").textContent, `${$("transcript").value.length}자`);
  assert.equal($("save-transcript").hidden, false); assert.equal($("clear-button").hidden, false);
  assert.equal($("summary-button").disabled, false, "pasted text can be summarised");
  process.stdout.write("PASS: editable transcript, live character count and autosave\n");

  d.querySelector('[data-action="settings"]').click();
  await until(() => $("settings-dialog").open, "preferences opens");
  assert.equal($("settings-form").elements.namedItem("language").value, "ko");
  assert.equal($("settings-form").elements.namedItem("whisper_model").value, "large-v3-turbo");
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
  // The saved file is marked on its day in the calendar and listed under that day.
  $("nav-history").click();
  await until(() => !$("history-view").hidden, "back to the record list");
  $("view-calendar").click();
  await until(() => !todayCell().querySelector(".saved-dot").hidden, "saved file marked on the calendar");
  assert.equal($("day-saved").hidden, false);
  assert.equal($("day-saved-list").querySelectorAll(".storage-file").length, 1);
  assert.match($("day-saved-list").querySelector("a").textContent, /^원문 · \d\d:\d\d · Markdown$/);
  $("view-list").click();
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
