"use strict";
const $ = (id) => document.getElementById(id);
let state = null, refreshing = false, pendingText = {}, saveTimer, saveChain = Promise.resolve();
let seenJob = "", toastTimer, exportKind = "transcript";
let draftPrompts = {}, editingPrompt = "", pollCounter = 0;
let openingDeepLink = false;
let privateGeneration = 0, editingFileId = null, pendingFileId = null, exportFileId = null;
let replaceFileId = null, promptChoice = "";
const editorSource = () => (editingFileId ? state?.files.find(file => file.id === editingFileId) : state) || {};
function showDialog(dialog) { if (!document.body.classList.contains("vault-locked")) dialog.showModal(); }
const isBusy = () => ["running", "stopping"].includes(state?.runtime.job?.status);
// The recording a running job belongs to: a file id, "notes" for the shared memo, or null.
const jobTarget = () => (isBusy() ? state.runtime.job.target : null);
// Summary format for one-click actions: the one picked here, else the one used last time.
function currentPrompt() {
  const names = Object.keys(state?.prompts || {});
  return [promptChoice, state?.last_prompt].find(name => names.includes(name)) || names[0];
}
const displayName = file => file.name.replace(/\.(wav|mp3|m4a|flac|ogg|aac|webm|mp4|aiff?)$/i, "");
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

class ApiError extends Error {
  constructor(detail, status) {
    super(typeof detail === "string" ? detail : detail?.message || JSON.stringify(detail));
    this.detail = detail; this.status = status;
  }
}
async function api(path, options = {}) {
  const headers = {"X-Scribe-Request": "1", ...options.headers};
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, {...options, headers});
  if (response.status === 401 || response.status === 423) window.ScribeVault.requireUnlock();
  let data;
  try { data = await response.json(); } catch { throw new Error("로컬 서버 응답을 읽을 수 없습니다."); }
  if (!response.ok) throw new ApiError(data.detail || "요청을 처리할 수 없습니다.", response.status);
  return data;
}
function toast(message, error = false) {
  clearTimeout(toastTimer); $("toast").textContent = message;
  $("toast").classList.toggle("error", error); $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 8000 : 3500);
}
function action(callback) {
  return async (event) => { try { await callback(event); } catch (error) { toast(error.message, true); } };
}
function setButton(button, label, glyph, stop = false) {
  if (button.dataset.label === label + glyph) return;   // keep focus and hover state across polling
  button.dataset.label = label + glyph;
  button.replaceChildren();
  const wrapper = document.createElement("span"); wrapper.innerHTML = icon(glyph);
  button.append(wrapper.firstChild, Object.assign(document.createElement("span"), {textContent: label}));
  button.classList.toggle("stop", stop);
}
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const value = Math.floor(seconds);
  const minutes = Math.floor(value / 60), rest = String(value % 60).padStart(2, "0");
  return `${String(minutes).padStart(2, "0")}:${rest}`;
}
function updateCounts() {
  $("transcript-count").textContent = `${$("transcript").value.length.toLocaleString()}자`;
  $("summary-count").textContent = `${$("summary").value.length.toLocaleString()}자`;
}
function renderFiles() { window.ScribeHistory?.render(state); }

// Buttons of the open record. One primary action: "요약하기" transcribes first when needed.
function renderActions() {
  if (!state) return;
  const busy = isBusy(), stopping = state.runtime.job?.status === "stopping";
  const isFile = !!editingFileId, mine = busy && jobTarget() === (editingFileId || "notes");
  const hasSummary = !!$("summary").value.trim(), hasText = !!$("transcript").value.trim();
  const elsewhere = busy && !mine ? "다른 작업이 끝난 뒤 사용할 수 있습니다." : "";
  if (mine) setButton($("summary-button"), "중단", "stop", true);
  else setButton($("summary-button"), hasSummary ? "다시 요약" : "요약하기", "spark");
  $("summary-button").classList.toggle("primary", !mine && !hasSummary);
  $("summary-button").disabled = mine ? stopping : busy || (!isFile && !hasText);
  $("summary-button").title = elsewhere || (mine ? "진행 중인 작업을 멈춥니다" : !isFile && !hasText ? "원문 탭에 글을 붙여 넣으면 요약할 수 있습니다."
    : hasText ? "고른 서식으로 요약합니다 (⌘⏎)" : "받아쓰기부터 요약까지 한 번에 진행합니다 (⌘⏎)");
  $("stt-button").hidden = !isFile;
  if (mine) setButton($("stt-button"), "중단", "stop", true);
  else setButton($("stt-button"), hasText ? "다시 받아쓰기" : "받아쓰기", "repeat");
  $("stt-button").disabled = mine ? stopping : busy;
  $("stt-button").title = elsewhere || (mine ? "진행 중인 작업을 멈춥니다" : "녹음을 다시 듣고 원문을 새로 씁니다. 지금 원문은 바뀝니다.");
  $("prompt-select").disabled = busy;
  for (const id of ["copy-button", "summary-replace", "save-summary"]) $(id).hidden = !hasSummary;
  $("summary-replace").disabled = busy || !hasSummary;
  $("copy-button").disabled = $("save-summary").disabled = !hasSummary;
  for (const id of ["copy-transcript", "save-transcript"]) { $(id).hidden = !hasText; $(id).disabled = !hasText; }
  $("clear-button").hidden = isFile || !hasText;
  $("clear-button").disabled = busy || !hasText;
  // While this record is being worked on, say so right where the result will appear.
  const job = state.runtime.job, percent = mine && job.progress != null ? ` ${Math.round(job.progress * 100)}%` : "";
  $("summary-note").textContent = $("transcript-note").textContent = mine ? job.message + percent : "";
  $("summary").placeholder = mine ? (job.stage === "stt" ? "녹음을 받아쓰고 있습니다. 끝나면 이어서 요약합니다." : "요약을 쓰고 있습니다. 곧 이 자리에 나타납니다.")
    : !isFile ? "원문 탭에 글을 붙여 넣고 ‘요약하기’를 누르세요."
    : hasText ? "‘요약하기’를 누르면 고른 서식으로 요약합니다.\n완성된 요약은 이 자리에서 바로 고칠 수 있습니다."
    : "‘요약하기’를 누르면 받아쓰기부터 요약까지 한 번에 진행합니다.\n완성된 요약은 이 자리에서 바로 고칠 수 있습니다.";
  $("transcript").placeholder = mine && job.stage === "stt" ? "녹음을 받아쓰고 있습니다. 끝나면 이 자리에 나타납니다."
    : isFile ? "‘요약하기’를 누르면 받아쓴 원문이 여기에 나옵니다. 틀린 곳은 바로 고칠 수 있습니다."
    : "받아쓴 원문이 차례로 모입니다. 다른 곳의 글을 붙여 넣어 요약할 수도 있습니다.";
}

function render() {
  const busy = isBusy(), job = state.runtime.job, stt = state.runtime.stt, setting = state.settings;
  const ollama = state.runtime.ollama;
  renderFiles();
  for (const key of ["transcript", "summary"]) {
    if (!(key in pendingText) && $(key).value !== (editorSource()[key] || "")) $(key).value = editorSource()[key] || "";
    $(key).readOnly = busy;
  }
  updateCounts();
  const names = Object.keys(state.prompts);
  if (JSON.stringify([...$("prompt-select").options].map(o => o.value)) !== JSON.stringify(names)) {
    $("prompt-select").replaceChildren(...names.map(name => new Option(name, name)));
  }
  if (document.activeElement !== $("prompt-select")) $("prompt-select").value = currentPrompt();
  renderActions();
  $("model-label").textContent = `요약 모델 ${setting.llm_model}`;
  const idle = !stt.installed || !ollama.models.includes(setting.llm_model)
    ? (ollama.connected || !stt.installed ? "모델을 아직 준비하지 못했습니다. 왼쪽 ‘설정’에서 ‘모델 준비’를 눌러 주세요."
      : "요약 프로그램(Ollama)이 꺼져 있습니다. 앱을 다시 시작해 주세요.")
    : `준비됨 · 음성 인식 ${setting.whisper_model} · 요약 ${setting.llm_model}`;
  const ready = stt.installed && ollama.models.includes(setting.llm_model);
  $("app-status").textContent = job?.message || idle;
  $("app-dot").className = `status-dot ${busy ? "working" : job?.status === "error" || !ready ? "error" : "ready"}`;
  $("job-progress").hidden = !busy;
  if (job?.progress === null || job?.progress === undefined) $("job-progress").removeAttribute("value");
  else { $("job-progress").max = 1; $("job-progress").value = job.progress; }
  const jobKey = job ? `${job.id}:${job.status}` : "";
  if (jobKey && jobKey !== seenJob) {
    const firstLook = !seenJob;
    seenJob = jobKey;
    if (!firstLook && job.status === "error") toast(job.message, true);
    if (!firstLook && (job.status === "completed" || job.status === "cancelled")) toast(job.message);
  }
  if ($("settings-dialog").open) renderSystemStatus();
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!await window.ScribeVault.sync()) return;
    const generation = privateGeneration;
    const nextState = await api(`/api/state${force ? "?refresh=true" : ""}`);
    if (generation !== privateGeneration || document.body.classList.contains("vault-locked")) return;
    state = nextState;
    render();
    if (location.hash === "#settings" && !openingDeepLink) {
      openingDeepLink = true;
      history.replaceState(null, "", location.pathname + location.search);
      try { await openSettings(); } finally { openingDeepLink = false; }
    }
  } catch (error) {
    $("app-status").textContent = "로컬 서버에 연결할 수 없습니다. start.command로 실행 상태를 확인하세요.";
    $("app-dot").className = "status-dot error";
    if (!state) toast(error.message, true);
  } finally { refreshing = false; }
}
function queueText(key) {
  pendingFileId = editingFileId; pendingText[key] = $(key).value; updateCounts();
  $("editor-save-status").textContent = "저장 중…";
  renderActions();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushText().catch(e => toast(e.message, true)), 650);
}
function flushText() {
  clearTimeout(saveTimer);
  saveChain = saveChain.catch(() => {}).then(async () => {
    const snapshot = {...pendingText};
    if (!Object.keys(snapshot).length) return;
    const targetId = pendingFileId;
    await api("/api/text", {method: "PATCH", body: {...snapshot, file_id: targetId}});
    for (const [key, value] of Object.entries(snapshot)) {
      if (pendingText[key] === value) delete pendingText[key];
      const target = targetId ? state?.files.find(file => file.id === targetId) : state;
      if (target) target[key] = value;
    }
    if (!Object.keys(pendingText).length) $("editor-save-status").textContent = "저장됨";
    window.ScribeHistory?.render(state);
  });
  return saveChain;
}
for (const key of ["transcript", "summary"]) $(key).addEventListener("input", () => queueText(key));

async function uploadFiles(files, recording = false) {
  if (!files.length) return;
  const data = new FormData(); for (const file of files) data.append("files", file);
  data.append("recording", String(recording));
  $("add-button").disabled = true;
  let added = [];
  try {
    added = (await api("/api/files", {method: "POST", body: data})).files;
  } finally { $("add-button").disabled = false; await refresh(); }
  // One new record opens straight away so the next step, "요약하기", is right there.
  if (added.length === 1) await window.ScribeHistory.openEditor(added[0].id, "summary");
  else toast(`${added.length}개 파일을 추가했습니다.`);
}
// The Mac app records natively, then asks the page to show the new record.
window.openRecord = async id => {
  for (let attempt = 0; attempt < 20 && !state?.files.some(file => file.id === id); attempt++) {
    await refresh();
    if (!state?.files.some(file => file.id === id)) await new Promise(resolve => setTimeout(resolve, 150));
  }
  await window.ScribeHistory.openEditor(id, "summary");
};
$("add-button").addEventListener("click", () => $("audio-input").click());
$("empty-add").addEventListener("click", () => $("audio-input").click());
$("audio-input").addEventListener("change", action(async () => {
  const files = [...$("audio-input").files]; $("audio-input").value = ""; await uploadFiles(files);
}));
let dragDepth = 0;
$("drop-zone").addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("drop-zone").classList.add("dragging"); });
$("drop-zone").addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
$("drop-zone").addEventListener("dragleave", e => { e.preventDefault(); if (--dragDepth <= 0) $("drop-zone").classList.remove("dragging"); });
$("drop-zone").addEventListener("drop", action(async e => {
  e.preventDefault(); dragDepth = 0; $("drop-zone").classList.remove("dragging"); await uploadFiles([...e.dataTransfer.files]);
}));
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => e.preventDefault());
$("clear-button").addEventListener("click", action(async () => {
  await flushText();
  const previous = $("transcript").value, fileId = editingFileId;
  $("transcript").value = ""; queueText("transcript"); await flushText(); await refresh();
  toastUndo("원문을 비웠습니다.", async () => {
    await api("/api/text", {method: "PATCH", body: {transcript: previous, file_id: fileId}}); await refresh(); toast("원문을 되돌렸습니다.");
  });
}));
async function stopJob() { await api("/api/cancel", {method: "POST"}); await refresh(); }
// "요약하기": the server transcribes first when the recording has no transcript yet.
async function startSummary(fileId = editingFileId, prompt = currentPrompt()) {
  await flushText();
  await api("/api/summary", {method: "POST", body: {prompt, file_id: fileId}});
  await refresh();
}
async function summarizeMany(ids) {
  await flushText();
  await api("/api/summary", {method: "POST", body: {prompt: currentPrompt(), ids}});
  await refresh();
}
$("prompt-select").addEventListener("change", () => { promptChoice = $("prompt-select").value; });
$("summary-button").addEventListener("click", action(async () => {
  if (isBusy()) return stopJob();
  await startSummary(editingFileId, $("prompt-select").value);
}));
$("stt-button").addEventListener("click", action(async () => {
  if (isBusy()) return stopJob();
  if (!editingFileId) return;
  await flushText(); await api(`/api/transcribe?file_id=${encodeURIComponent(editingFileId)}`, {method: "POST"}); await refresh();
}));
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", action(async () => {
  await navigator.clipboard.writeText($(button.dataset.copy).value);
  toast(button.dataset.copy === "summary" ? "요약을 복사했습니다." : "원문을 복사했습니다.");
})));

function openSave(kind) {
  if (!$(kind).value.trim()) return toast("저장할 내용이 없습니다.", true);
  exportKind = kind; exportFileId = editingFileId; $("save-plain").checked = false;
  $("save-title").textContent = kind === "transcript" ? "원문을 파일로 저장" : "요약을 파일로 저장"; showDialog($("save-dialog"));
}
$("save-transcript").onclick = () => openSave("transcript"); $("save-summary").onclick = () => openSave("summary");
$("save-form").addEventListener("submit", action(async e => {
  e.preventDefault(); await flushText();
  const result = await api("/api/export", {method: "POST", body: {kind: exportKind, format: $("save-format").value, file_id: exportFileId}});
  if (document.body.classList.contains("vault-locked")) return;
  if ($("save-plain").checked) {
    if (window.webkit?.messageHandlers?.scribeVault) {
      window.ScribeVault.bridge({action: "export", url: result.url, filename: result.filename});
    } else {
      const link = document.createElement("a"); link.href = result.url; link.download = result.filename;
      document.body.append(link); link.click(); link.remove();
    }
  }
  $("save-dialog").close(); toast("저장했습니다. 왼쪽 ‘저장한 파일’에서 다시 볼 수 있습니다.");
  window.ScribeHistory?.loadSaved();
}));
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
document.addEventListener("click", e => document.querySelectorAll("details.menu[open]").forEach(menu => { if (!menu.contains(e.target)) menu.open = false; }));

function statusLine(message, ready) {
  const line = document.createElement("div"); line.className = "system-status-line";
  const dot = document.createElement("span"); dot.className = `status-dot ${ready ? "ready" : ""}`;
  line.append(dot, document.createTextNode(message)); return line;
}
function renderSystemStatus() {
  const ollama = state.runtime.ollama, stt = state.runtime.stt;
  const lines = [statusLine(ollama.connected ? `Ollama 연결됨 · 설치된 로컬 모델 ${ollama.models.length}개` : "Ollama에 연결할 수 없습니다. Ollama를 실행하세요.", ollama.connected),
    statusLine(stt.state === "ready" ? `음성 인식 ${state.settings.whisper_model} · ${stt.device}에서 실행` : stt.installed ? `음성 인식 ${state.settings.whisper_model} · 준비됨` : `음성 인식 ${state.settings.whisper_model} · 아직 없음. 아래 ‘모델 준비’를 눌러 주세요.`, stt.installed)];
  for (const model of ollama.running) lines.push(statusLine(`${model.name} · ${model.device}에서 실행 중`, true));
  $("system-status-list").replaceChildren(...lines);
  $("data-path").textContent = state.runtime.data_path;
  const setup = isBusy() && state.runtime.job.type === "setup";
  $("setup-progress").hidden = !setup;
  $("setup-progress").textContent = setup ? state.runtime.job.message : "";
  $("prepare-models").disabled = isBusy();
  $("settings-form").querySelectorAll("input,select,button[type=submit]").forEach(el => { el.disabled = isBusy(); });
}
function populateLlmModels(selected = $("llm-model").value || state.settings.llm_model) {
  const values = new Set([...state.runtime.qwen_models, ...state.runtime.ollama.models, selected]);
  $("llm-model").replaceChildren(...[...values].filter(name => !$("qwen-only").checked || /qwen/i.test(name) || name === selected).map(name => {
    return new Option(`${name}${state.runtime.ollama.models.includes(name) ? " · 설치됨" : " · 다운로드 필요"}`, name);
  }));
  $("llm-model").value = selected;
}
async function openSettings() {
  if (!state) throw new Error("로컬 서버에 연결될 때까지 기다려 주세요.");
  if (isBusy()) return toast("작업이 끝난 뒤 설정을 변경할 수 있습니다.");
  await flushText(); await refresh(true); populateLlmModels(state.settings.llm_model);
  for (const [key, value] of Object.entries(state.settings)) {
    const field = $("settings-form").elements.namedItem(key); if (field) field.value = value;
  }
  $("settings-error").hidden = true; renderSystemStatus(); showDialog($("settings-dialog"));
}
function settingsData() {
  const data = Object.fromEntries(new FormData($("settings-form")));
  for (const key of ["context_length", "max_tokens", "temperature"]) data[key] = Number(data[key]);
  return data;
}
async function storeSettings(close = true) {
  if (!$("settings-form").reportValidity()) return false;
  await api("/api/settings", {method: "PUT", body: settingsData()});
  if (close) $("settings-dialog").close();
  await refresh(true); return true;
}
$("settings-form").addEventListener("submit", async e => {
  e.preventDefault();
  try { if (await storeSettings()) toast("설정을 저장했습니다."); }
  catch (error) { $("settings-error").textContent = error.message; $("settings-error").hidden = false; }
});
$("qwen-only").addEventListener("change", () => populateLlmModels());
$("refresh-status").addEventListener("click", action(async () => { await refresh(true); populateLlmModels(); }));
$("prepare-models").addEventListener("click", async () => {
  try {
    if (!await storeSettings(false)) return;
    await api("/api/models/prepare", {method: "POST", body: {whisper: true, ollama: true}}); await refresh();
  } catch (error) { $("settings-error").textContent = error.message; $("settings-error").hidden = false; }
});

function savePromptDraft() { if (editingPrompt) draftPrompts[editingPrompt] = $("prompt-editor").value; }
function renderPromptEditor(name) {
  $("edit-prompt-select").replaceChildren(...Object.keys(draftPrompts).map(key => new Option(key, key)));
  editingPrompt = name || Object.keys(draftPrompts)[0];
  $("edit-prompt-select").value = editingPrompt; $("prompt-editor").value = draftPrompts[editingPrompt];
  $("remove-prompt").disabled = Object.keys(draftPrompts).length <= 1;
}
function openPrompts() {
  if (!state || isBusy()) return toast("작업이 끝난 뒤 서식을 변경할 수 있습니다.");
  draftPrompts = {...state.prompts}; renderPromptEditor($("prompt-select").value);
  $("new-prompt-name").value = ""; showDialog($("prompts-dialog"));
}
$("edit-prompt-select").addEventListener("change", () => { savePromptDraft(); renderPromptEditor($("edit-prompt-select").value); });
$("add-prompt").addEventListener("click", () => {
  const name = $("new-prompt-name").value.trim(); if (!name) return toast("새 서식 이름을 입력하세요.", true);
  if (name in draftPrompts) return toast("같은 이름의 서식이 있습니다.", true);
  savePromptDraft(); draftPrompts[name] = "다음 대화를 정리하세요.\n\n## 주요 내용\n## 후속 조치";
  renderPromptEditor(name); $("new-prompt-name").value = ""; $("prompt-editor").focus();
});
$("remove-prompt").addEventListener("click", () => { if (Object.keys(draftPrompts).length > 1) { delete draftPrompts[editingPrompt]; renderPromptEditor(); } });
$("prompts-form").addEventListener("submit", action(async e => {
  e.preventDefault(); savePromptDraft(); await api("/api/prompts", {method: "PUT", body: {prompts: draftPrompts}});
  $("prompts-dialog").close(); await refresh(); toast("요약 서식을 저장했습니다.");
}));
// A saved result in the user's words: "요약 · 11월 13일 14:02 · Markdown".
function savedLabel(file, withDate = true) {
  const match = /_(stt|summary)\.(txt|md)$/.exec(file.name);
  if (!match || !file.modified) return file.name;
  const date = new Date(file.modified * 1000), two = value => String(value).padStart(2, "0");
  const day = withDate ? `${date.getMonth() + 1}월 ${date.getDate()}일 ` : "";
  return `${match[1] === "stt" ? "원문" : "요약"} · ${day}${two(date.getHours())}:${two(date.getMinutes())} · ${match[2] === "md" ? "Markdown" : "텍스트"}`;
}
// One row of a stored file: opens a preview in the Mac app, exports or downloads elsewhere.
function storageRow(file, kind, generation, withDate = true) {
  const row = document.createElement("div"); row.className = "storage-file";
  const link = document.createElement("a"); link.href = file.url; link.download = file.name;
  link.textContent = kind === "results" ? savedLabel(file, withDate) : file.name;
  const size = document.createElement("span"); size.textContent = file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (document.body.dataset.panel && kind === "results") {
    link.addEventListener("click", action(async event => {
      event.preventDefault();
      const open = row.nextElementSibling?.classList.contains("file-preview");
      row.parentElement.querySelector(".file-preview")?.remove();
      if (open) return;   // a second click closes the preview
      const preview = document.createElement("pre");
      const response = await fetch(file.url);
      if (!response.ok) throw new Error("저장한 파일을 열 수 없습니다.");
      preview.textContent = await response.text();
      if (generation !== privateGeneration || document.body.classList.contains("vault-locked") || !row.isConnected) return;
      preview.className = "file-preview";
      row.after(preview);
    }));
  } else if (window.webkit?.messageHandlers?.scribeVault) {
    link.addEventListener("click", event => {
      event.preventDefault();
      window.ScribeVault.bridge({action: "export", url: file.url, filename: file.name});
    });
  }
  link.title = kind === "recordings" ? "암호화를 해제한 일반 음성 파일 내보내기" : `저장한 파일 열기 · ${file.name}`;
  row.append(link, size);
  return row;
}
async function openStorage(kind) {
  const generation = privateGeneration;
  const data = await api(`/api/storage/${kind}`);
  if (generation !== privateGeneration || document.body.classList.contains("vault-locked")) return;
  $("storage-title").textContent = kind === "results" ? "저장한 파일" : "녹음 파일";
  $("storage-list").replaceChildren();
  if (!data.files.length) {
    const empty = document.createElement("p"); empty.className = "storage-empty"; empty.textContent = "저장된 파일이 없습니다."; $("storage-list").append(empty);
  }
  for (const file of data.files) $("storage-list").append(storageRow(file, kind, generation));
  showDialog($("storage-dialog"));
}
// Batch correction is an explicit action on the summary opened in this dialog.
function addReplaceRow(rule = {find: "", replace: ""}) {
  const row = document.createElement("div"); row.className = "replace-rule";
  const field = (cls, value, label, example) => {
    const input = Object.assign(document.createElement("input"), {className: cls, value, placeholder: example, maxLength: 200});
    input.setAttribute("aria-label", label); return input;
  };
  const find = field("replace-find", rule.find, "찾을 말", "예: 아울록");
  const to = field("replace-to", rule.replace, "바꿀 말", "예: 아웃룩");
  const arrow = Object.assign(document.createElement("span"), {className: "replace-arrow", textContent: "→"});
  const remove = Object.assign(document.createElement("button"), {type: "button", className: "icon-button", innerHTML: icon("close")});
  remove.setAttribute("aria-label", "규칙 삭제");
  remove.onclick = () => { row.remove(); if (!$("replace-rules").children.length) addReplaceRow(); };
  row.append(find, arrow, to, remove); $("replace-rules").append(row);
  return find;
}
function openReplace() {
  if ($("detail-view").hidden || $("summary-panel").hidden || !$("summary").value.trim() || isBusy()) return;
  replaceFileId = editingFileId;
  $("replace-scope").textContent = `‘${$("detail-title").textContent}’의 요약 본문에서만 수정합니다.`;
  $("replace-rules").replaceChildren(); $("replace-error").hidden = true;
  const rules = state?.replacements || [];
  (rules.length ? rules : [undefined]).forEach(rule => addReplaceRow(rule));
  showDialog($("replace-dialog"));
}
async function saveReplaceRules() {
  const rules = [...document.querySelectorAll(".replace-rule")]
    .map(row => ({find: row.querySelector(".replace-find").value.trim(), replace: row.querySelector(".replace-to").value}))
    .filter(rule => rule.find);
  const saved = await api("/api/replacements", {method: "PUT", body: {rules}});
  if (state) state.replacements = saved.rules;
  return saved.rules;
}
function replaceAction(callback) {
  return async event => {
    $("replace-error").hidden = true;
    try { await callback(event); } catch (error) { $("replace-error").textContent = error.message; $("replace-error").hidden = false; }
  };
}
function toastUndo(message, undo) {
  toast(message); clearTimeout(toastTimer);
  const button = Object.assign(document.createElement("button"), {type: "button", className: "toast-action", textContent: "되돌리기"});
  button.onclick = action(async () => { $("toast").hidden = true; await undo(); });
  $("toast").append(button);
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 10000);
}
document.querySelectorAll("[data-open-replace]").forEach(button => button.addEventListener("click", openReplace));
$("add-replace-rule").addEventListener("click", () => addReplaceRow().focus());
$("save-replace").addEventListener("click", replaceAction(async () => {
  await saveReplaceRules(); $("replace-dialog").close(); toast("일괄 수정 규칙을 저장했습니다.");
}));
$("replace-form").addEventListener("submit", replaceAction(async event => {
  event.preventDefault();
  const targetId = replaceFileId, generation = privateGeneration;
  if (isBusy()) throw new Error("작업이 끝난 뒤 일괄 수정하세요.");
  const rules = await saveReplaceRules();
  if (!rules.length) throw new Error("찾을 말을 하나 이상 입력하세요.");
  await flushText();
  if (generation !== privateGeneration || !state) return;
  const target = targetId ? state.files.find(file => file.id === targetId) : state;
  if (!target) throw new Error("수정할 요약의 기록을 찾을 수 없습니다.");
  const before = target.summary || "";
  const result = await api("/api/replacements/apply", {method: "POST", body: {file_id: targetId, rules}});
  if (generation !== privateGeneration) return;
  target.summary = result.summary;
  $("replace-dialog").close(); await refresh();
  if (!result.count) return toast("바꿀 곳이 없습니다. 규칙은 저장했습니다.");
  toastUndo(`이 요약의 ${result.count}곳을 고쳤습니다.`, async () => {
    await flushText();
    await api("/api/text", {method: "PATCH", body: {file_id: targetId, summary: before}});
    await refresh(); toast("일괄 수정을 되돌렸습니다.");
  });
}));
document.addEventListener("keydown", event => {
  if (!(event.metaKey || event.ctrlKey) || document.querySelector("dialog[open]") || document.body.classList.contains("vault-locked") || $("detail-view").hidden) return;
  if (event.key === "Enter" && !isBusy() && !$("summary-button").disabled) { event.preventDefault(); $("summary-button").click(); }
  if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    const kind = $("summary-panel").hidden ? "transcript" : "summary";
    if ($(kind).value.trim()) openSave(kind);
  }
});
function showInfo(title, content) { $("info-title").textContent = title; $("info-content").innerHTML = content; showDialog($("info-dialog")); }
$("help-button").onclick = () => showInfo("사용 방법", `
  <h3>1. 녹음하기</h3><p>‘녹음 시작’을 누르고 이야기한 뒤 ‘녹음 종료’를 누르세요. 방금 녹음한 기록이 바로 열립니다. 이미 있는 음성 파일은 ‘파일 추가’로 불러오거나 창에 끌어다 놓으면 됩니다.</p>
  <h3>2. 요약하기</h3><p>서식(일반 요약, 회의록 등)을 고르고 ‘요약하기’를 누르세요. 받아쓰기와 요약을 차례로 한 번에 진행합니다. 긴 회의는 자동으로 여러 구간으로 나눠 정리한 뒤 하나로 합칩니다.</p>
  <h3>3. 바로 고치기</h3><p>요약은 보이는 자리에서 바로 고칠 수 있고, 고친 내용은 자동으로 저장됩니다. ‘원문’ 탭에서는 받아쓴 글을 확인하고 고칠 수 있습니다. 원문을 고친 뒤 ‘다시 요약’을 누르면 고친 내용으로 새로 요약합니다. 자주 틀리는 낱말은 ‘일괄 수정’으로 한꺼번에 바꾸세요.</p>
  <h3>4. 내보내기</h3><p>‘복사’로 다른 앱에 붙여 넣거나, ‘파일로 저장…’으로 TXT·Markdown 파일을 만드세요. 저장한 파일은 왼쪽 ‘저장한 파일’에서 다시 볼 수 있습니다. 암호화하지 않은 일반 파일이 필요하면 저장 창에서 ‘일반 파일도 내보내기’를 선택하세요.</p>
  <h3>목록과 달력</h3><p>기록 화면 위쪽의 ‘목록 / 달력’으로 보기 방식을 바꿉니다. 달력은 녹음이 많은 날일수록 진한 색으로 보여 주고, 주황색 점은 그날 저장한 파일이 있다는 표시입니다. 날짜를 누르면 그날의 녹음과 저장한 파일이 나옵니다.</p>
  <h3>전체 메모</h3><p>받아쓴 원문이 차례로 모이는 곳입니다. 여러 녹음을 한데 모아 요약하거나, 다른 곳의 글을 붙여 넣어 요약할 때 씁니다.</p>
  <h3>보관함 잠금</h3><p>녹음과 글은 암호화해 보관하며 Mac 앱에서 Touch ID 또는 Mac 로그인 암호로만 엽니다. 암호는 macOS 인증창에서 입력하며 별도 앱 비밀번호는 없습니다. 5분 동안 쓰지 않으면 자동으로 잠깁니다. 백업에는 vault.json을 포함한 data 폴더 전체와 이 보관함의 Mac 키체인 항목이 필요합니다. Mac 로그인 암호만으로는 다른 Mac에서 복구할 수 없습니다.</p>
  <h3>모델과 데이터</h3><p>음성과 글은 이 Mac(localhost) 안에서만 처리합니다. 인터넷은 ‘설정’에서 모델을 처음 내려받을 때만 사용합니다. 음성 인식 모델과 요약 모델은 ‘설정’에서 바꿀 수 있습니다.</p>`);
$("licenses-button").onclick = () => showInfo("Third-Party Licenses", `
  <p>원본의 공개 소개와 매뉴얼을 참고해 localhost용으로 새로 구현한 프로그램입니다.</p>
  <table><tbody><tr><td>faster-whisper / CTranslate2 / Whisper</td><td>MIT</td></tr><tr><td>FastAPI / Uvicorn / HTTPX</td><td>MIT / BSD</td></tr><tr><td>PyAV / FFmpeg</td><td>BSD / LGPL·GPL</td></tr><tr><td>NumPy / ONNX Runtime</td><td>BSD / MIT</td></tr><tr><td>Ollama</td><td>MIT</td></tr><tr><td>Qwen3</td><td>Apache-2.0</td></tr></tbody></table>
  <p>자세한 고지와 구성요소별 공식 라이선스는 프로젝트의 THIRD_PARTY_NOTICES.md에서 확인할 수 있습니다.</p>
  <p><a href="https://azimuthkorea.blogspot.com/2026/10/azimuth-scribe.html" target="_blank" rel="noreferrer">원본 Azimuth Scribe 소개 ↗</a></p>`);
document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", action(async () => {
  const menu = button.closest("details"); if (menu) menu.open = false;
  const name = button.dataset.action;
  if (name === "settings") return openSettings(); if (name === "prompts") return openPrompts();
  if (name === "results" || name === "recordings") return openStorage(name);
})));

// Microphone data stays in the browser until it is saved to this localhost server.
let recorder = null, micStream = null, audioContext = null, animationFrame = 0, recordingTimer = 0;
let unsavedRecording = null, recordingStarted = 0, recordSaving = false;
function resetRecorder() {
  clearInterval(recordingTimer); cancelAnimationFrame(animationFrame);
  micStream?.getTracks().forEach(track => track.stop()); micStream = null;
  if (audioContext) audioContext.close().catch(() => {}); audioContext = null;
  recorder = null; $("workspace").classList.remove("recording");
  $("waveform").hidden = true; $("record-time").hidden = true;
}
function recorderReady() {
  $("record-status").textContent = "녹음 준비"; $("record-hint").textContent = "녹음을 마치면 ‘요약하기’ 한 번으로 정리됩니다.";
  setButton($("record-button"), "녹음 시작", "mic"); $("record-button").disabled = false;
}
async function saveRecording() {
  recordSaving = true; $("record-button").disabled = true; $("record-status").textContent = "저장 중…";
  try {
    await uploadFiles([unsavedRecording], true); unsavedRecording = null; recorderReady();
  } catch (error) {
    $("record-status").textContent = "저장 대기"; $("record-hint").textContent = "녹음을 보관 중입니다. 다시 저장해 주세요.";
    setButton($("record-button"), "다시 저장", "save"); $("record-button").disabled = false; toast(error.message, true);
  } finally { recordSaving = false; }
}
function startMeter(stream) {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const values = new Uint8Array(analyser.frequencyBinCount), canvas = $("waveform"), context = canvas.getContext("2d");
    canvas.hidden = false;
    const draw = () => {
      analyser.getByteTimeDomainData(values); context.clearRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#be4f60"; context.lineWidth = 1.5; context.beginPath();
      values.forEach((value, i) => { const x = i * canvas.width / values.length, y = value / 128 * canvas.height / 2; i ? context.lineTo(x, y) : context.moveTo(x, y); });
      context.stroke(); animationFrame = requestAnimationFrame(draw);
    }; draw();
  } catch { /* Meter availability does not affect the captured audio. */ }
}
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("이 브라우저는 마이크 녹음을 지원하지 않습니다. 최신 Safari 또는 Chrome에서 localhost로 열어 주세요.");
  $("record-button").disabled = true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, sampleRate: 16000, echoCancellation: true}});
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"].find(t => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(micStream, type ? {mimeType: type} : {});
    const chunks = [], startedDate = new Date(); recordingStarted = performance.now();
    recorder.addEventListener("dataavailable", e => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener("error", () => { toast("마이크 오류가 발생했습니다. 녹음된 구간을 저장합니다.", true); if (recorder?.state === "recording") recorder.stop(); });
    recorder.addEventListener("stop", async () => {
      const mime = recorder.mimeType || type || "audio/webm";
      resetRecorder();
      const blob = new Blob(chunks, {type: mime});
      if (!blob.size) { recorderReady(); return toast("녹음된 데이터가 없습니다.", true); }
      const two = value => String(value).padStart(2, "0");
      const stamp = `${startedDate.getFullYear()}-${two(startedDate.getMonth() + 1)}-${two(startedDate.getDate())} ${two(startedDate.getHours())}.${two(startedDate.getMinutes())} 녹음`;
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      unsavedRecording = new File([blob], `${stamp}.${ext}`, {type: mime}); await saveRecording();
    });
    micStream.getAudioTracks().forEach(track => track.addEventListener("ended", () => { if (recorder?.state === "recording") { toast("마이크 연결이 끊겼습니다. 녹음된 구간을 저장합니다."); recorder.stop(); } }));
    recorder.start(1000); startMeter(micStream);
    $("workspace").classList.add("recording"); $("record-status").textContent = "녹음 중";
    $("record-hint").textContent = "마치려면 녹음 종료를 누르세요."; $("record-time").hidden = false;
    $("record-time").textContent = "00:00"; setButton($("record-button"), "녹음 종료", "stop", true);
    $("record-button").disabled = false;
    recordingTimer = setInterval(() => { $("record-time").textContent = formatDuration((performance.now() - recordingStarted) / 1000); window.ScribeVault.touch(); }, 250);
  } catch (error) {
    resetRecorder(); recorderReady();
    throw new Error(error.name === "NotAllowedError" ? "브라우저에서 마이크 접근을 허용한 뒤 다시 시도하세요." : `마이크를 시작할 수 없습니다. ${error.message}`);
  }
}
$("record-button").addEventListener("click", action(async () => {
  if (recordSaving) return;
  if (unsavedRecording) return saveRecording();
  if (recorder?.state === "recording") { $("record-button").disabled = true; recorder.stop(); return; }
  await startRecording();
}));
window.addEventListener("beforeunload", event => {
  if (recorder?.state === "recording" || unsavedRecording || Object.keys(pendingText).length) { event.preventDefault(); event.returnValue = ""; }
});
window.flushBeforeVaultLock = flushText;
window.addEventListener("vault-locked", () => {
  privateGeneration += 1;
  clearTimeout(saveTimer); pendingText = {}; state = null; draftPrompts = {}; editingPrompt = "";
  seenJob = ""; promptChoice = ""; editingFileId = pendingFileId = exportFileId = replaceFileId = null;
  window.ScribeHistory?.clear();
  for (const id of ["transcript", "summary", "prompt-editor", "new-prompt-name", "audio-input"]) $(id).value = "";
  $("file-list").replaceChildren(); $("replace-rules").replaceChildren(); $("storage-list").replaceChildren();
  $("info-content").replaceChildren(); $("toast").hidden = true; updateCounts();
  if (recorder?.state === "recording") recorder.stop();
});
window.addEventListener("vault-unlocked", () => setTimeout(() => refresh(), 0));
window.addEventListener("vault-native-error", event => toast(event.detail, true));
refresh();
window.addEventListener("hashchange", () => refresh());
setInterval(() => { if (isBusy() || ++pollCounter % 8 === 0) refresh(); }, 900);
