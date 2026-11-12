// In-memory DOM checks. This does not launch or control a web browser.
// NODE_PATH=/path/to/node_modules node tests/dom-smoke.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {JSDOM, VirtualConsole} = require("jsdom");
const root = path.resolve(__dirname, "..");
const folder = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-dom-"));
const base = "http://127.0.0.1:8767";
const log = fs.openSync(path.join(folder, "server.log"), "w");
const child = spawn(path.join(root, ".venv/bin/python"), [path.join(root, "server.py")], {
  env: {...process.env, SCRIBE_DATA_DIR: folder, SCRIBE_PORT: "8767"}, stdio: ["ignore", log, log]
});
let dom;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, limit = 10000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timeout: ${message}`);
}
async function readState() { return (await fetch(base + "/api/state")).json(); }
async function main() {
  await until(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "test server readiness");
  const errors = [], downloads = [];
  const console = new VirtualConsole();
  console.on("jsdomError", e => errors.push(e));
  dom = new JSDOM(fs.readFileSync(path.join(root, "static/index.html"), "utf8"), {
    url: base, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console
  });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id);
  w.fetch = (url, options) => fetch(new URL(url, base), options);
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.HTMLAnchorElement.prototype.click = function() { downloads.push(this.href); };
  w.addEventListener("error", e => errors.push(e.error));
  w.eval(fs.readFileSync(path.join(root, "static/app.js"), "utf8"));
  await until(() => $("app-status").textContent.includes("모델"), "initial DOM render");
  assert.equal($("file-count").textContent, "0 files");
  assert.equal($("prompt-select").options.length, 4);
  assert.equal($("stt-button").disabled, true);
  process.stdout.write("PASS: initial UI state, empty file list, four prompt choices\n");

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
  $("save-format").value = "md";
  $("save-form").dispatchEvent(new w.Event("submit", {bubbles: true, cancelable: true}));
  await until(() => downloads.length === 1, "export click");
  assert.equal(await (await fetch(downloads[0])).text(), $("transcript").value);
  assert.ok(downloads[0].endsWith(".md"));
  $("help-button").click(); assert.ok($("info-content").textContent.includes("localhost")); $("info-dialog").close();
  $("licenses-button").click(); assert.ok($("info-content").textContent.includes("faster-whisper")); $("info-dialog").close();
  assert.deepEqual(errors.map(e => e.message), []);
  process.stdout.write("PASS: Markdown save/download, help, notices and no JavaScript runtime errors\n");
}
main().catch(error => { process.stderr.write(error.stack + "\n"); process.exitCode = 1; }).finally(async () => {
  dom?.window.close(); child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", resolve); });
  fs.closeSync(log); fs.rmSync(folder, {recursive: true, force: true});
});
