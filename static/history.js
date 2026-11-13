"use strict";
// The record list (as a list or as a calendar heatmap) and the page of one open record.
// Cards are keyed by record id so state polling updates them in place.
window.ScribeHistory = (() => {
  const cards = new Map();
  const TABS = ["summary", "transcript"];
  const NOTES_HINT = "받아쓴 원문이 차례로 모이는 곳입니다. 다른 곳의 글을 붙여 넣어 요약할 수도 있습니다.";
  // "list" or "calendar"; empty until the saved preference arrives with the first state.
  let viewMode = "", shownMonth = null, selectedDay = "", savedFiles = [], savedRows = "";
  const two = value => String(value).padStart(2, "0");
  const dayKey = date => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const dayDate = key => new Date(key + "T00:00:00");
  const fileDay = file => (file.created ? dayKey(new Date(file.created * 1000)) : "");
  const searched = () => {
    const query = $("history-search").value.trim().toLocaleLowerCase();
    return (state?.files || []).filter(file => !query || [file.name, file.transcript, file.summary].some(value => value?.toLocaleLowerCase().includes(query)));
  };
  // The calendar shows one day at a time; the list shows everything that matches the search.
  const visibleFiles = () => (viewMode === "calendar" ? searched().filter(file => fileDay(file) === selectedDay) : searched());
  // A two-line preview shows the content itself: no section headings, no Markdown marks.
  const preview = text => (text || "").replace(/^[ \t]*#{1,6}[ \t]+.*$/gm, "").replace(/^[ \t]*([-*>]|\d+\.)[ \t]+/gm, "").replace(/[*`]/g, "").replace(/\s+/g, " ").trim();
  function dateLabel(seconds) {
    if (!seconds) return "";
    const date = new Date(seconds * 1000), now = new Date(), yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (date.toDateString() === now.toDateString()) return `오늘 ${time}`;
    if (date.toDateString() === yesterday.toDateString()) return `어제 ${time}`;
    return `${date.getFullYear() === now.getFullYear() ? "" : `${date.getFullYear()}년 `}${date.getMonth() + 1}월 ${date.getDate()}일 ${time}`;
  }
  const metaLine = file => [file.duration ? formatDuration(file.duration) : "", dateLabel(file.created)].filter(Boolean).join(" · ");
  // What the user needs to know about one record, in their words.
  function fileState(file) {
    if (jobTarget() === file.id) return {kind: "working", text: state.runtime.job.stage === "stt" ? "받아쓰는 중…" : "요약하는 중…"};
    if (file.error) return {kind: "error", text: "실패"};
    if (file.summary?.trim()) return {kind: "done", text: ""};
    return {kind: "pending", text: ""};   // the "요약하기" button already says what is left to do
  }

  function setTab(name) {
    for (const kind of TABS) {
      const selected = kind === name;
      $("tab-" + kind).setAttribute("aria-selected", String(selected));
      $("tab-" + kind).tabIndex = selected ? 0 : -1;
      $(kind + "-panel").hidden = !selected;
    }
  }
  function unloadAudio() {
    const audio = $("detail-audio");
    if (!audio.paused) audio.pause();
    if (audio.dataset.id) { delete audio.dataset.id; audio.removeAttribute("src"); if (audio.readyState) audio.load(); }
    audio.hidden = true;
  }
  function view(editor) {
    if (!editor) unloadAudio();
    $("history-view").hidden = editor;
    $("detail-view").hidden = !editor;
    $("nav-history").classList.toggle("active", !editor || !!editingFileId);
    $("nav-notes").classList.toggle("active", editor && !editingFileId);
    $("nav-history").setAttribute("aria-current", !editor || editingFileId ? "page" : "false");
    $("nav-notes").setAttribute("aria-current", editor && !editingFileId ? "page" : "false");
  }
  async function showHistory() {
    await flushText(); editingFileId = null; view(false);
    if (state) render();
  }
  // Opens one record (or the shared memo when id is null). The summary comes first:
  // it is what people come to read, and it is edited right there.
  async function openEditor(id = null, tab = null) {
    await flushText();
    const file = id ? state?.files.find(item => item.id === id) : null;
    if (id && !file) return;
    editingFileId = id; unloadAudio(); view(true);
    setTab(tab || (!id && !state?.summary?.trim() ? "transcript" : "summary"));
    if (file) {
      const audio = $("detail-audio");
      audio.dataset.id = file.id; audio.hidden = false;
      audio.src = `/api/download/recordings/${encodeURIComponent(file.stored_name)}`;
      audio.setAttribute("aria-label", displayName(file) + " 재생");
    }
    $("editor-save-status").textContent = "고치면 자동으로 저장됩니다";
    render();
    document.querySelector(".app-content").scrollTop = 0;
    const next = !$("summary-panel").hidden && !$("summary").value.trim() && !$("summary-button").disabled ? $("summary-button") : $("back-to-history");
    next.focus();
  }

  function buildCard(file) {
    const node = document.createElement("article");
    node.className = "history-card"; node.dataset.id = file.id;
    node.innerHTML = `<button class="card-main" type="button"><span class="card-top"><span class="card-title"></span><span class="card-meta"></span></span><span class="card-text"></span></button>
      <p class="card-error" role="status" hidden></p>
      <div class="card-side"><span class="file-status" role="status"></span><button class="button card-run" type="button"></button><button class="icon-button card-remove" type="button" title="목록에서 지우기 · 암호화된 녹음 파일은 보관함에 남습니다" aria-label="이 기록을 목록에서 지우기">${icon("trash")}</button></div>`;
    const find = selector => node.querySelector(selector);
    find(".card-main").onclick = action(() => openEditor(file.id));
    find(".card-run").onclick = action(async () => {
      if (jobTarget() === file.id) return stopJob();
      await startSummary(file.id);
    });
    find(".card-remove").onclick = action(async () => {
      await flushText(); await api("/api/files/remove", {method: "POST", body: {ids: [file.id]}});
      await refresh(); toast("목록에서 지웠습니다. 암호화된 녹음 파일은 보관함에 남아 있습니다.");
    });
    return node;
  }
  function updateCard(node, file) {
    const find = selector => node.querySelector(selector), busy = isBusy();
    const status = fileState(file), active = status.kind === "working";
    const name = displayName(file);
    find(".card-title").textContent = name;
    find(".card-meta").textContent = metaLine(file);
    find(".card-main").setAttribute("aria-label", `${name} 열기`);
    const text = preview(file.summary) || preview(file.transcript);
    find(".card-text").textContent = text || "아직 내용이 없습니다. ‘요약하기’를 누르면 받아쓰기와 요약을 한 번에 진행합니다.";
    find(".card-text").classList.toggle("placeholder", !text);
    find(".file-status").textContent = status.text;
    find(".file-status").className = "file-status " + status.kind;
    node.classList.toggle("working", active);
    find(".card-error").hidden = !file.error || active; find(".card-error").textContent = file.error || "";
    const run = find(".card-run");
    run.hidden = status.kind === "done";
    if (active) setButton(run, "중단", "stop", true); else setButton(run, "요약하기", "spark");
    run.classList.toggle("primary", !active);
    run.disabled = active ? state.runtime.job.status === "stopping" : busy;
    run.title = active ? "진행 중인 작업을 멈춥니다" : busy ? "다른 작업이 끝난 뒤 사용할 수 있습니다." : `‘${currentPrompt()}’ 서식으로 받아쓰기와 요약을 한 번에 진행합니다`;
    find(".card-remove").disabled = busy;
  }
  function renderDetail(next) {
    const target = next.files.find(file => file.id === editingFileId);
    if (editingFileId && !target) { editingFileId = null; view(false); }
    const title = $("detail-title");
    if (document.activeElement !== title) title.textContent = target ? displayName(target) : "전체 메모";
    title.setAttribute("contenteditable", target && !isBusy() ? "plaintext-only" : "false");
    title.title = target ? "눌러서 이름을 바꿀 수 있습니다" : "";
    $("detail-description").textContent = target ? metaLine(target) : NOTES_HINT;
    const failed = target?.error && jobTarget() !== target.id;
    $("detail-error").hidden = !failed; $("detail-error").textContent = failed ? target.error : "";
  }
  // ---------- Calendar: the same records by day, coloured by how many were recorded ----------
  const lengthLabel = seconds => {
    const minutes = Math.round(seconds / 60);
    return minutes < 1 ? "1분 미만" : minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""}`;
  };
  function pickDay(key) {
    const date = dayDate(key);
    selectedDay = key; shownMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  }
  function selectDay(key, focus = false) {
    pickDay(key);
    if (state) render();
    if (focus) $("calendar-grid").querySelector(`[data-day="${key}"]`)?.focus();
  }
  // Start on today when it has recordings, otherwise on the most recent day that does.
  function startCalendar() {
    if (selectedDay) return;
    const today = dayKey(new Date()), days = (state?.files || []).map(fileDay).filter(Boolean).sort();
    pickDay(days.includes(today) || !days.length ? today : days[days.length - 1]);
  }
  function moveMonth(delta) {
    const month = new Date(shownMonth.getFullYear(), shownMonth.getMonth() + delta, 1), today = new Date();
    const prefix = `${month.getFullYear()}-${two(month.getMonth() + 1)}`;
    const recorded = (state?.files || []).map(fileDay).filter(key => key.startsWith(prefix)).sort();
    selectDay(dayKey(today).startsWith(prefix) ? dayKey(today) : recorded[recorded.length - 1] || `${prefix}-01`);
  }
  async function loadSaved() {
    const generation = privateGeneration;
    try {
      const data = await api("/api/storage/results");
      if (generation !== privateGeneration || document.body.classList.contains("vault-locked")) return;
      savedFiles = data.files;
      if (state) render();
    } catch { /* The calendar still shows recordings; only the saved-file marks are missing. */ }
  }
  function setView(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    if (mode === "calendar") { startCalendar(); loadSaved(); }
    // A preference only: switching never waits for it or fails because of it.
    api("/api/view", {method: "PUT", body: {view: mode}}).catch(() => {});
    if (state) render();
  }
  function renderCalendar(next) {
    const on = viewMode === "calendar";
    $("view-list").setAttribute("aria-pressed", String(!on));
    $("view-calendar").setAttribute("aria-pressed", String(on));
    $("history-body").classList.toggle("calendar", on);
    $("calendar-panel").hidden = !on;
    if (!on) { for (const id of ["day-title", "day-saved", "day-empty"]) $(id).hidden = true; return; }
    const days = new Map(), saved = new Map();
    for (const file of searched()) {
      const key = fileDay(file);
      if (!key) continue;
      const day = days.get(key) || {count: 0, seconds: 0};
      day.count += 1; day.seconds += file.duration || 0; days.set(key, day);
    }
    for (const file of savedFiles) {
      const key = dayKey(new Date(file.modified * 1000));
      saved.set(key, [...(saved.get(key) || []), file]);
    }
    const most = Math.max(1, ...[...days.values()].map(day => day.count));
    const year = shownMonth.getFullYear(), month = shownMonth.getMonth(), monthKey = `${year}-${two(month + 1)}`;
    $("calendar-title").textContent = `${year}년 ${month + 1}월`;
    const grid = $("calendar-grid");
    if (grid.dataset.month !== monthKey) {   // built once per month so polling keeps keyboard focus
      grid.dataset.month = monthKey; grid.replaceChildren();
      for (let blank = new Date(year, month, 1).getDay(); blank > 0; blank--) grid.append(document.createElement("span"));
      for (let date = 1, last = new Date(year, month + 1, 0).getDate(); date <= last; date++) {
        const cell = Object.assign(document.createElement("button"), {type: "button", className: "calendar-day"});
        cell.dataset.day = `${monthKey}-${two(date)}`;
        cell.innerHTML = `<span class="calendar-date">${date}</span><span class="calendar-count"></span><i class="saved-dot" hidden></i>`;
        grid.append(cell);
      }
    }
    const today = dayKey(new Date());
    for (const cell of grid.querySelectorAll(".calendar-day")) {
      const key = cell.dataset.day, day = days.get(key), files = saved.get(key) || [], date = Number(key.slice(8));
      // Four steps of colour: one recording is the lightest; beyond four a day, relative to the busiest day.
      const level = !day ? 0 : most <= 4 ? day.count : Math.max(1, Math.ceil(day.count / most * 4));
      cell.className = `calendar-day level-${level}${key === today ? " today" : ""}`;
      cell.querySelector(".calendar-count").textContent = day ? day.count : "";
      cell.querySelector(".saved-dot").hidden = !files.length;
      cell.setAttribute("aria-pressed", String(key === selectedDay));
      cell.tabIndex = key === selectedDay || (!selectedDay.startsWith(monthKey) && date === 1) ? 0 : -1;
      cell.setAttribute("aria-label", `${month + 1}월 ${date}일, 녹음 ${day?.count || 0}개${files.length ? `, 저장한 파일 ${files.length}개` : ""}`);
      cell.title = [day ? `녹음 ${day.count}개 · ${lengthLabel(day.seconds)}` : "", files.length ? `저장한 파일 ${files.length}개` : ""].filter(Boolean).join(" · ");
    }
    const chosen = days.get(selectedDay), files = saved.get(selectedDay) || [], picked = dayDate(selectedDay);
    $("day-title").hidden = false;
    $("day-title").textContent = `${picked.getMonth() + 1}월 ${picked.getDate()}일 ${"일월화수목금토"[picked.getDay()]}요일` + (chosen ? ` · 녹음 ${chosen.count}개 · ${lengthLabel(chosen.seconds)}` : "");
    $("day-empty").hidden = !!chosen || !next.files.length;
    $("day-empty").textContent = $("history-search").value.trim() ? "이 날은 검색에 맞는 녹음이 없습니다." : "이 날은 녹음이 없습니다.";
    $("day-saved").hidden = !files.length;
    const rows = files.map(file => file.filename).join("|");
    if (rows !== savedRows) {   // keeps an open preview while the state is polled
      savedRows = rows;
      $("day-saved-list").replaceChildren(...files.map(file => storageRow(file, "results", privateGeneration, false)));
    }
  }

  function renderHistory(next) {
    if (!next) return;
    if (!viewMode) {
      viewMode = next.view === "calendar" ? "calendar" : "list";
      if (viewMode === "calendar") loadSaved();
    }
    if (viewMode === "calendar") startCalendar();
    const visible = visibleFiles(), visibleIds = new Set(visible.map(file => file.id));
    const pending = next.files.filter(file => !file.summary?.trim());
    $("history-count").textContent = next.files.length;
    $("empty-files").hidden = !!next.files.length;
    $("no-search-results").hidden = viewMode === "calendar" || !next.files.length || !!visible.length;
    renderCalendar(next);
    // Leftover recordings can be finished in one go; hidden while searching so the scope is never unclear.
    $("pending-bar").hidden = isBusy() || !!$("history-search").value.trim() || pending.length < 2;
    $("pending-count").textContent = `아직 요약하지 않은 기록 ${pending.length}개`;
    $("summarize-all").title = `‘${currentPrompt()}’ 서식으로 차례로 요약합니다`;
    for (const [id, card] of cards) {
      if (!next.files.some(file => file.id === id)) { card.remove(); cards.delete(id); }
    }
    [...next.files].reverse().forEach((file, index) => {
      let card = cards.get(file.id);
      if (!card) { card = buildCard(file); cards.set(file.id, card); }
      if ($("file-list").children[index] !== card) $("file-list").insertBefore(card, $("file-list").children[index] || null);
      card.hidden = !visibleIds.has(file.id);
      updateCard(card, file);
    });
    renderDetail(next);
  }
  function clear() {
    cards.clear(); unloadAudio();
    viewMode = ""; shownMonth = null; selectedDay = ""; savedFiles = []; savedRows = "";
    delete $("calendar-grid").dataset.month;
    $("calendar-grid").replaceChildren(); $("day-saved-list").replaceChildren();
    $("calendar-panel").hidden = $("day-title").hidden = $("day-saved").hidden = $("day-empty").hidden = true;
    $("history-body").classList.remove("calendar");
    $("history-search").value = ""; $("history-count").textContent = "0";
    $("detail-title").textContent = "전체 메모"; $("detail-description").textContent = "";
    $("editor-save-status").textContent = "고치면 자동으로 저장됩니다"; view(false);
  }

  $("history-search").addEventListener("input", () => { if (state) render(); });
  $("view-list").onclick = () => setView("list");
  $("view-calendar").onclick = () => setView("calendar");
  $("calendar-prev").onclick = () => moveMonth(-1);
  $("calendar-next").onclick = () => moveMonth(1);
  $("calendar-today").onclick = () => selectDay(dayKey(new Date()));
  $("calendar-grid").addEventListener("click", event => {
    const cell = event.target.closest(".calendar-day");
    if (cell) selectDay(cell.dataset.day);
  });
  // Arrow keys move day by day and across months, like a native date grid.
  $("calendar-grid").addEventListener("keydown", event => {
    const step = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7}[event.key];
    const cell = event.target.closest(".calendar-day");
    if (!step || !cell) return;
    event.preventDefault();
    const date = dayDate(cell.dataset.day); date.setDate(date.getDate() + step);
    selectDay(dayKey(date), true);
  });
  $("nav-history").onclick = $("back-to-history").onclick = action(showHistory);
  $("nav-notes").onclick = action(() => openEditor());
  $("summarize-all").onclick = action(async () => {
    await summarizeMany(state.files.filter(file => !file.summary?.trim()).map(file => file.id));
  });
  for (const kind of TABS) {
    $("tab-" + kind).onclick = () => setTab(kind);
    $("tab-" + kind).onkeydown = event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tab = event.key === "Home" ? TABS[0] : event.key === "End" ? TABS[1] : TABS[1 - TABS.indexOf(kind)];
      setTab(tab); $("tab-" + tab).focus();
    };
  }
  // Rename in place: Enter saves, Escape cancels.
  const title = $("detail-title");
  title.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); title.blur(); }
    if (event.key === "Escape") {
      const file = state?.files.find(item => item.id === editingFileId);
      if (file) title.textContent = displayName(file);
      title.blur();
    }
  });
  title.addEventListener("blur", action(async () => {
    const file = state?.files.find(item => item.id === editingFileId);
    if (!file) return;
    const name = title.textContent.replace(/\s+/g, " ").trim();
    if (!name || name === displayName(file)) { title.textContent = displayName(file); return; }
    try {
      await flushText(); await api("/api/text", {method: "PATCH", body: {file_id: file.id, name}});
      file.name = name; toast("이름을 바꿨습니다.");
    } finally { await refresh(); }
  }));
  const audio = $("detail-audio");
  audio.addEventListener("play", () => window.ScribeVault.touch());
  audio.addEventListener("timeupdate", () => { if (!audio.paused) window.ScribeVault.touch(); });
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !$("history-view").hidden && !document.body.classList.contains("vault-locked") && !document.querySelector("dialog[open]")) {
      event.preventDefault(); $("history-search").focus();
    }
  });
  return {render: renderHistory, clear, showHistory, openEditor, visibleFiles, loadSaved};
})();
