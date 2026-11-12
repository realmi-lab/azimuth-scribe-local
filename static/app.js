"use strict";
const $ = (id) => document.getElementById(id);
let state = null, refreshing = false, pendingText = {}, saveTimer, saveChain = Promise.resolve();
let currentFileSignature = "", seenJob = "", toastTimer, exportKind = "transcript";
let draftPrompts = {}, editingPrompt = "", pollCounter = 0;
let openingDeepLink = false;
const isBusy = () => ["running", "stopping"].includes(state?.runtime.job?.status);
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
  if (document.body.dataset.panel) label = ({Stop:"중단", STT:"받아쓰기", Summary:"요약 생성"})[label] || label;
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
function renderFiles() {
  const signature = JSON.stringify(state.files);
  const selected = state.files.filter(f => f.selected);
  $("select-all").checked = !!state.files.length && selected.length === state.files.length;
  $("select-all").indeterminate = selected.length > 0 && selected.length < state.files.length;
  $("select-all").disabled = !state.files.length;
  $("file-count").textContent = `${state.files.length} files${selected.length ? ` · ${selected.length} selected` : ""}`;
  if (signature === currentFileSignature) return;
  currentFileSignature = signature;
  $("empty-files").hidden = state.files.length > 0;
  $("file-list").replaceChildren();
  for (const file of state.files) {
    const row = document.createElement("tr");
    const selectedCell = document.createElement("td"); selectedCell.className = "select-cell";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox";
    checkbox.checked = file.selected; checkbox.setAttribute("aria-label", `${file.name} 선택`);
    checkbox.addEventListener("change", action(async () => {
      try { await api("/api/files/selection", {method: "PATCH", body: {ids: [file.id], selected: checkbox.checked}}); }
      finally { await refresh(); }
    }));
    selectedCell.append(checkbox);
    const nameCell = document.createElement("td"), name = document.createElement("span");
    name.className = "filename"; name.textContent = file.name; name.title = file.name;
    nameCell.append(name);
    const duration = document.createElement("td"); duration.className = "duration";
    duration.textContent = formatDuration(file.duration);
    const statusCell = document.createElement("td"), status = document.createElement("span");
    status.className = `file-status ${file.status}`; status.textContent = file.status;
    status.title = file.error || file.status;
    statusCell.append(status); row.append(selectedCell, nameCell, duration, statusCell);
    $("file-list").append(row);
  }
}
function render() {
  const busy = isBusy(), job = state.runtime.job, stt = state.runtime.stt;
  renderFiles();
  for (const key of ["transcript", "summary"]) {
    if (!(key in pendingText) && $(key).value !== state[key]) $(key).value = state[key];
    $(key).readOnly = busy;
  }
  updateCounts();
  const choice = $("prompt-select").value;
  if (JSON.stringify([...$("prompt-select").options].map(o => o.value)) !== JSON.stringify(Object.keys(state.prompts))) {
    $("prompt-select").replaceChildren(...Object.keys(state.prompts).map(name => new Option(name, name)));
    if (choice in state.prompts) $("prompt-select").value = choice;
  }
  $("prompt-select").disabled = busy;
  const activeStt = busy && job.type === "stt", activeSummary = busy && job.type === "summary";
  setButton($("stt-button"), activeStt ? "Stop" : "STT", activeStt ? "stop" : "spark", activeStt);
  setButton($("summary-button"), activeSummary ? "Stop" : "Summary", activeSummary ? "stop" : "spark", activeSummary);
  $("stt-button").disabled = (busy && !activeStt) || job?.status === "stopping" || (!busy && !state.files.some(f => f.selected));
  $("summary-button").disabled = (busy && !activeSummary) || job?.status === "stopping";
  $("delete-button").disabled = busy || !state.files.some(f => f.selected);
  $("clear-button").disabled = busy || !$("transcript").value;
  $("save-transcript").disabled = !$("transcript").value.trim();
  $("save-summary").disabled = !$("summary").value.trim();
  $("copy-button").disabled = !$("summary").value.trim();
  const setting = state.settings;
  const runningModel = state.runtime.ollama.running.find(m => m.name === setting.llm_model);
  const selectedDevice = {auto: "Auto", cpu: "CPU", gpu: "GPU 우선"}[setting.llm_device];
  $("model-label").textContent = `Model: ${setting.llm_model} · Device: ${runningModel?.device || selectedDevice}`;
  const status = job?.message || (stt.state === "ready" ? `STT model ready. [${setting.whisper_model} · ${stt.device}]` : stt.installed ? `Whisper ${setting.whisper_model} 설치됨 · STT 실행 시 모델을 불러옵니다.` : "Settings → Preferences에서 로컬 모델을 준비해 주세요.");
  $("app-status").textContent = status;
  $("app-dot").className = `status-dot ${busy ? "working" : job?.status === "error" ? "error" : stt.installed ? "ready" : ""}`;
  $("job-progress").hidden = !busy;
  if (job?.progress === null || job?.progress === undefined) $("job-progress").removeAttribute("value");
  else { $("job-progress").max = 1; $("job-progress").value = job.progress; }
  const jobKey = job ? `${job.id}:${job.status}` : "";
  if (jobKey && jobKey !== seenJob) {
    if (job.status === "error") toast(job.message, true);
    if (job.status === "completed" || job.status === "cancelled") toast(job.message);
    seenJob = jobKey;
  }
  if ($("settings-dialog").open) renderSystemStatus();
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api(`/api/state${force ? "?refresh=true" : ""}`);
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
  pendingText[key] = $(key).value; updateCounts();
  $("clear-button").disabled = !$("transcript").value;
  $("copy-button").disabled = !$("summary").value.trim();
  $("save-transcript").disabled = !$("transcript").value.trim();
  $("save-summary").disabled = !$("summary").value.trim();
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flushText().catch(e => toast(e.message, true)), 650);
}
function flushText() {
  clearTimeout(saveTimer);
  saveChain = saveChain.catch(() => {}).then(async () => {
    const snapshot = {...pendingText};
    if (!Object.keys(snapshot).length) return;
    await api("/api/text", {method: "PATCH", body: snapshot});
    for (const [key, value] of Object.entries(snapshot)) {
      if (pendingText[key] === value) delete pendingText[key];
      if (state) state[key] = value;
    }
  });
  return saveChain;
}
for (const key of ["transcript", "summary"]) $(key).addEventListener("input", () => queueText(key));

async function uploadFiles(files, recording = false) {
  if (!files.length) return;
  const data = new FormData(); for (const file of files) data.append("files", file);
  data.append("recording", String(recording));
  $("add-button").disabled = true;
  try {
    await api("/api/files", {method: "POST", body: data});
    toast(recording ? "녹음을 저장했습니다." : `${files.length}개 파일을 추가했습니다.`);
  } finally { $("add-button").disabled = false; await refresh(); }
}
$("add-button").addEventListener("click", () => $("audio-input").click());
$("empty-files").addEventListener("click", () => $("audio-input").click());
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
$("select-all").addEventListener("change", action(async () => {
  await api("/api/files/selection", {method: "PATCH", body: {ids: state.files.map(f => f.id), selected: $("select-all").checked}}); await refresh();
}));
$("delete-button").addEventListener("click", action(async () => {
  await api("/api/files/remove", {method: "POST", body: {ids: state.files.filter(f => f.selected).map(f => f.id)}});
  toast("선택한 파일을 목록에서 제거했습니다. 디스크의 파일은 보관됩니다."); await refresh();
}));
$("clear-button").addEventListener("click", action(async () => { $("transcript").value = ""; queueText("transcript"); await flushText(); await refresh(); }));
async function stopJob() { await api("/api/cancel", {method: "POST"}); await refresh(); }
$("stt-button").addEventListener("click", action(async () => {
  if (isBusy()) return stopJob();
  await flushText(); await api("/api/transcribe", {method: "POST"}); await refresh();
}));
async function confirmContext(message) {
  $("confirm-message").textContent = message; $("confirm-dialog").showModal();
  return new Promise(resolve => {
    const finish = answer => { $("confirm-dialog").close(); resolve(answer); };
    $("confirm-yes").onclick = () => finish(true); $("confirm-no").onclick = () => finish(false);
    $("confirm-dialog").oncancel = () => resolve(false);
  });
}
async function startSummary(expand = false) {
  try { await api("/api/summary", {method: "POST", body: {prompt: $("prompt-select").value, expand_context: expand}}); }
  catch (error) {
    if (error.detail?.code === "context" && !expand) {
      if (await confirmContext(error.detail.message)) return startSummary(true);
      return;
    }
    throw error;
  }
  await refresh();
}
$("summary-button").addEventListener("click", action(async () => { if (isBusy()) return stopJob(); await flushText(); await startSummary(); }));
$("copy-button").addEventListener("click", action(async () => { await navigator.clipboard.writeText($("summary").value); toast("요약을 클립보드에 복사했습니다."); }));

function openSave(kind) {
  if (!$(kind).value.trim()) return toast("저장할 내용이 없습니다.", true);
  exportKind = kind; $("save-title").textContent = kind === "transcript" ? "받아쓰기 저장" : "요약 저장"; $("save-dialog").showModal();
}
$("save-transcript").onclick = () => openSave("transcript"); $("save-summary").onclick = () => openSave("summary");
$("save-form").addEventListener("submit", action(async e => {
  e.preventDefault(); await flushText();
  const result = await api("/api/export", {method: "POST", body: {kind: exportKind, format: $("save-format").value}});
  const link = document.createElement("a"); link.href = result.url; link.download = result.filename;
  if (!document.body.dataset.panel) { document.body.append(link); link.click(); link.remove(); } $("save-dialog").close(); toast("Results 폴더에 저장했습니다.");
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
    statusLine(stt.state === "ready" ? `Whisper ${state.settings.whisper_model} · ${stt.device}` : stt.installed ? `Whisper ${state.settings.whisper_model} · 다운로드 완료` : "선택한 Whisper 모델을 내려받아 주세요.", stt.installed)];
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
  $("settings-error").hidden = true; renderSystemStatus(); $("settings-dialog").showModal();
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
  $("new-prompt-name").value = ""; $("prompts-dialog").showModal();
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
async function openStorage(kind) {
  const data = await api(`/api/storage/${kind}`); $("storage-title").textContent = kind === "results" ? "Results · 저장 결과" : "Recordings · 녹음 파일";
  $("storage-list").replaceChildren();
  if (!data.files.length) {
    const empty = document.createElement("p"); empty.className = "storage-empty"; empty.textContent = "저장된 파일이 없습니다."; $("storage-list").append(empty);
  }
  for (const file of data.files) {
    const row = document.createElement("div"); row.className = "storage-file";
    const link = document.createElement("a"); link.href = file.url; link.download = file.name; link.textContent = file.name;
    const size = document.createElement("span"); size.textContent = file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
    if (document.body.dataset.panel && kind === "results") {
      link.addEventListener("click", action(async event => {
        event.preventDefault();
        const preview = document.createElement("pre");
        const response = await fetch(file.url);
        if (!response.ok) throw new Error("결과를 열 수 없습니다.");
        preview.textContent = await response.text();
        $("storage-list").querySelector(".file-preview")?.remove();
        preview.className = "file-preview";
        row.after(preview);
      }));
    }
    row.append(link, size); $("storage-list").append(row);
  }
  $("storage-dialog").showModal();
}
function showInfo(title, content) { $("info-title").textContent = title; $("info-content").innerHTML = content; $("info-dialog").showModal(); }
$("help-button").onclick = () => showInfo("Azimuth Scribe 사용 방법", `
  <h3>1. 녹음하거나 파일 추가</h3><p>Start record를 눌러 마이크 권한을 허용한 뒤 대화를 녹음하세요. Stop record로 마치면 16 kHz 모노 WAV로 저장됩니다. 기존 파일은 Add로 여러 개를 추가할 수 있습니다.</p>
  <h3>2. 음성을 텍스트로 변환</h3><p>변환할 파일을 체크하고 STT를 누르세요. 선택 순서가 아닌 목록 순서대로 처리합니다. Stop을 누르면 현재 구간 처리 후 멈추며, 완료된 파일의 결과는 남습니다.</p>
  <h3>3. 받아쓰기 확인</h3><p>오인식된 이름, 숫자, 날짜 등을 직접 고치세요. 다른 곳에서 작성한 대화를 붙여 넣어 요약할 수도 있습니다.</p>
  <h3>4. 요약과 저장</h3><p>일반 요약·회의록·진료 기록·법률 상담 중 서식을 고르고 Summary를 누르세요. 결과는 생성되는 대로 표시됩니다. Copy to Clipboard로 복사하거나 Save…로 TXT·Markdown 파일을 저장하세요.</p>
  <h3>모델과 데이터</h3><p>Settings → Preferences에서 모델, 언어, 실행 장치를 설정합니다. 모델 준비 시에만 모델 파일을 외부에서 내려받습니다. 음성·텍스트는 localhost에서 처리하며, 녹음과 결과는 이 프로젝트의 data 폴더에 보관합니다. 입력한 텍스트와 설정도 자동으로 저장됩니다.</p>`);
$("licenses-button").onclick = () => showInfo("Third-Party Licenses", `
  <p>원본의 공개 소개와 매뉴얼을 참고해 localhost용으로 새로 구현한 프로그램입니다.</p>
  <table><tbody><tr><td>faster-whisper / CTranslate2 / Whisper</td><td>MIT</td></tr><tr><td>FastAPI / Uvicorn / HTTPX</td><td>MIT / BSD</td></tr><tr><td>PyAV / FFmpeg</td><td>BSD / LGPL·GPL</td></tr><tr><td>NumPy / ONNX Runtime</td><td>BSD / MIT</td></tr><tr><td>Ollama</td><td>MIT</td></tr><tr><td>Qwen3</td><td>Apache-2.0</td></tr></tbody></table>
  <p>자세한 고지와 구성요소별 공식 라이선스는 프로젝트의 THIRD_PARTY_NOTICES.md에서 확인할 수 있습니다.</p>
  <p><a href="https://azimuthkorea.blogspot.com/2026/10/azimuth-scribe.html" target="_blank" rel="noreferrer">원본 Azimuth Scribe 소개 ↗</a></p>`);
document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", action(async () => {
  button.closest("details").open = false;
  const name = button.dataset.action;
  if (name === "settings") return openSettings(); if (name === "prompts") return openPrompts();
  if (name === "results" || name === "recordings") return openStorage(name);
  openSave(name === "save-transcript" ? "transcript" : "summary");
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
  $("record-status").textContent = "Ready"; $("record-hint").textContent = "마이크로 대화를 녹음하세요.";
  setButton($("record-button"), "Start record", "mic"); $("record-button").disabled = false;
}
async function saveRecording() {
  recordSaving = true; $("record-button").disabled = true; $("record-status").textContent = "Saving…";
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
      const stamp = `${startedDate.getFullYear()}-${String(startedDate.getMonth() + 1).padStart(2, "0")}-${String(startedDate.getDate()).padStart(2, "0")}_${String(startedDate.getHours()).padStart(2, "0")}-${String(startedDate.getMinutes()).padStart(2, "0")}-${String(startedDate.getSeconds()).padStart(2, "0")}`;
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      unsavedRecording = new File([blob], `${stamp}.${ext}`, {type: mime}); await saveRecording();
    });
    micStream.getAudioTracks().forEach(track => track.addEventListener("ended", () => { if (recorder?.state === "recording") { toast("마이크 연결이 끊겼습니다. 녹음된 구간을 저장합니다."); recorder.stop(); } }));
    recorder.start(1000); startMeter(micStream);
    $("workspace").classList.add("recording"); $("record-status").textContent = "Recording…";
    $("record-hint").textContent = "녹음 중 · 마치려면 Stop record"; $("record-time").hidden = false;
    $("record-time").textContent = "00:00"; setButton($("record-button"), "Stop record", "stop", true);
    $("record-button").disabled = false;
    recordingTimer = setInterval(() => { $("record-time").textContent = formatDuration((performance.now() - recordingStarted) / 1000); }, 250);
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
refresh();
window.addEventListener("hashchange", () => refresh());
setInterval(() => { if (isBusy() || ++pollCounter % 8 === 0) refresh(); }, 900);
