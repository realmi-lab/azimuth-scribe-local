"use strict";
// Keyed cards keep their audio element and scroll position across state polling.
window.ScribeHistory = (() => {
  const cards = new Map();
  const statusNames = {Pending: "받아쓰기 전", Processing: "받아쓰는 중", Completed: "받아쓰기 완료", Error: "처리 실패"};
  const visibleFiles = () => {
    const query = $("history-search").value.trim().toLocaleLowerCase();
    return (state?.files || []).filter(file => !query || [file.name, file.transcript, file.summary].some(value => value?.toLocaleLowerCase().includes(query)));
  };
  function pauseAudio(audio, unload = false) {
    if (!audio.paused) audio.pause();
    if (unload) {
      audio.removeAttribute("src");
      if (audio.readyState) audio.load();
    }
  }
  function setTab(name) {
    for (const kind of ["transcript", "summary"]) {
      const selected = kind === name;
      $("tab-" + kind).setAttribute("aria-selected", String(selected));
      $("tab-" + kind).tabIndex = selected ? 0 : -1;
      $(kind + "-panel").hidden = !selected;
    }
  }
  function view(editor) {
    if (editor) cards.forEach(card => pauseAudio(card.querySelector("audio")));
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
  async function openEditor(id = null, tab = "transcript") {
    await flushText();
    if (id && !state?.files.some(file => file.id === id)) return;
    editingFileId = id; view(true); setTab(tab); render();
    $("detail-title").focus();
  }
  function buildCard(file) {
    const node = document.createElement("article");
    node.className = "history-card"; node.dataset.id = file.id; node.dataset.tab = "transcript";
    node.innerHTML = `<div class="card-header"><label class="card-selection"><input type="checkbox"><span class="sr-only">선택</span></label><button class="card-title"></button><span class="file-status"></span></div>
      <p class="card-text"></p><p class="card-error" role="status" hidden></p>
      <div class="card-player"><audio controls preload="metadata"></audio><span class="card-duration"></span></div>
      <div class="card-footer"><div class="card-tabs" role="group" aria-label="미리보기"><button data-tab="transcript" aria-pressed="true">원문</button><button data-tab="summary" aria-pressed="false">요약</button></div><button class="card-open">편집</button><span class="toolbar-spacer"></span><button class="icon-button card-copy" title="표시된 내용 복사" aria-label="표시된 내용 복사">${icon("copy")}</button><details class="card-reprocess"><summary title="다시 처리" aria-label="다시 처리">${icon("repeat")}</summary><div class="card-process-menu"><span>다시 처리</span><button class="retranscribe">음성 → 받아쓰기</button><div class="summary-choices"></div></div></details><details class="card-info"><summary title="기록 정보" aria-label="기록 정보">${icon("info")}</summary><div class="card-info-content"></div></details><button class="icon-button card-remove" title="목록에서 제거 · 녹음 파일은 유지" aria-label="이 기록을 목록에서 제거">${icon("trash")}</button></div>`;
    const find = selector => node.querySelector(selector);
    const latest = () => state?.files.find(item => item.id === file.id);
    find("input").onchange = action(async event => {
      event.target.disabled = true;
      try { await api("/api/files/selection", {method: "PATCH", body: {ids: [file.id], selected: event.target.checked}}); }
      finally { await refresh(); }
    });
    find(".card-title").onclick = find(".card-open").onclick = action(() => openEditor(file.id, node.dataset.tab));
    for (const button of node.querySelectorAll("[data-tab]")) button.onclick = () => {
      node.dataset.tab = button.dataset.tab; if (latest()) updateCard(node, latest());
    };
    find(".card-copy").onclick = action(async () => {
      await navigator.clipboard.writeText(latest()?.[node.dataset.tab] || ""); toast("클립보드에 복사했습니다.");
    });
    find(".retranscribe").onclick = action(async () => {
      find(".card-reprocess").open = false;
      await flushText(); await api(`/api/transcribe?file_id=${encodeURIComponent(file.id)}`, {method: "POST"}); await refresh();
    });
    find(".card-remove").onclick = action(async () => {
      await flushText(); await api("/api/files/remove", {method: "POST", body: {ids: [file.id]}});
      await refresh(); toast("목록에서 제거했습니다. 보관함의 녹음 파일은 유지됩니다.");
    });
    const audio = find("audio");
    audio.src = `/api/download/recordings/${encodeURIComponent(file.stored_name)}`;
    audio.setAttribute("aria-label", file.name + " 재생");
    audio.addEventListener("play", () => {
      cards.forEach(card => { const other = card.querySelector("audio"); if (other !== audio) pauseAudio(other); });
      window.ScribeVault.touch();
    });
    audio.addEventListener("timeupdate", () => { if (!audio.paused) window.ScribeVault.touch(); });
    return node;
  }
  function updateCard(node, file) {
    const find = selector => node.querySelector(selector), busy = isBusy();
    find("input").checked = file.selected; find("input").disabled = busy;
    find("input").setAttribute("aria-label", file.name + " 선택");
    find(".card-title").textContent = file.name; find(".card-title").title = file.name;
    const status = find(".file-status"); status.textContent = statusNames[file.status] || file.status;
    status.className = "file-status " + file.status;
    const text = file[node.dataset.tab] || "";
    find(".card-text").textContent = text || (node.dataset.tab === "summary" ? "아직 요약이 없습니다. 다시 처리에서 요약 서식을 고르세요." : "받아쓰기를 실행하면 이곳에 원문이 표시됩니다.");
    find(".card-text").classList.toggle("placeholder", !text);
    find(".card-error").hidden = !file.error; find(".card-error").textContent = file.error || "";
    find(".card-duration").textContent = formatDuration(file.duration);
    for (const button of node.querySelectorAll("[data-tab]")) button.setAttribute("aria-pressed", String(button.dataset.tab === node.dataset.tab));
    find(".card-copy").disabled = !text;
    find(".card-remove").disabled = find(".retranscribe").disabled = busy;
    const info = `${file.name}\n길이 ${formatDuration(file.duration)} · ${status.textContent}\n보관함에 암호화 저장`;
    find(".card-info-content").textContent = info;
    const choices = find(".summary-choices");
    if (choices.dataset.prompts !== JSON.stringify(Object.keys(state.prompts))) {
      choices.dataset.prompts = JSON.stringify(Object.keys(state.prompts)); choices.replaceChildren();
      for (const prompt of Object.keys(state.prompts)) {
        const button = Object.assign(document.createElement("button"), {textContent: prompt});
        button.onclick = action(async () => {
          find(".card-reprocess").open = false; node.dataset.tab = "summary";
          await flushText(); await startSummary(false, file.id, prompt);
        });
        choices.append(button);
      }
    }
    choices.querySelectorAll("button").forEach(button => { button.disabled = busy || !file.transcript?.trim(); });
  }
  function renderHistory(next) {
    if (!next) return;
    const visible = visibleFiles(), visibleIds = new Set(visible.map(file => file.id));
    const selectedVisible = visible.filter(file => file.selected);
    $("history-count").textContent = next.files.length;
    $("file-count").textContent = `${visible.length}개${selectedVisible.length ? ` · ${selectedVisible.length}개 선택` : ""}`;
    $("select-all").checked = !!visible.length && selectedVisible.length === visible.length;
    $("select-all").indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length;
    $("select-all").disabled = !visible.length || isBusy();
    $("empty-files").hidden = !!next.files.length;
    $("no-search-results").hidden = !next.files.length || !!visible.length;
    for (const [id, card] of cards) {
      if (!next.files.some(file => file.id === id)) { pauseAudio(card.querySelector("audio"), true); card.remove(); cards.delete(id); }
    }
    const files = [...next.files].reverse();
    files.forEach((file, index) => {
      let card = cards.get(file.id);
      if (!card) { card = buildCard(file); cards.set(file.id, card); }
      if ($("file-list").children[index] !== card) $("file-list").insertBefore(card, $("file-list").children[index] || null);
      card.hidden = !visibleIds.has(file.id);
      if (card.hidden) pauseAudio(card.querySelector("audio"));
      updateCard(card, file);
    });
    if (editingFileId && !next.files.some(file => file.id === editingFileId)) { editingFileId = null; view(false); }
    const target = next.files.find(file => file.id === editingFileId);
    $("detail-title").textContent = target?.name || "전체 메모";
    $("detail-eyebrow").textContent = target ? "RECORDING" : "WORKSPACE";
    $("detail-description").textContent = target ? `${formatDuration(target.duration)} · 이 기록의 원문과 요약을 편집합니다.` : "모아 둔 받아쓰기와 직접 쓴 메모입니다. 기록별 편집과 별도로 저장됩니다.";
  }
  function clear() {
    cards.forEach(card => pauseAudio(card.querySelector("audio"), true)); cards.clear();
    $("history-search").value = ""; $("history-count").textContent = "0";
    $("detail-title").textContent = "전체 메모"; $("detail-description").textContent = "";
    $("editor-save-status").textContent = "보관함에 자동 저장"; view(false);
  }
  $("history-search").addEventListener("input", () => { if (state) render(); });
  $("nav-history").onclick = $("back-to-history").onclick = action(showHistory);
  $("nav-notes").onclick = action(() => openEditor());
  $("detail-title").tabIndex = -1;
  for (const kind of ["transcript", "summary"]) {
    $("tab-" + kind).onclick = () => setTab(kind);
    $("tab-" + kind).onkeydown = event => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const tab = event.key === "Home" ? "transcript" : event.key === "End" ? "summary" : kind === "transcript" ? "summary" : "transcript";
        setTab(tab); $("tab-" + tab).focus();
      }
    };
  }
  document.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && !$("history-view").hidden && !document.body.classList.contains("vault-locked") && !document.querySelector("dialog[open]")) {
      event.preventDefault(); $("history-search").focus();
    }
  });
  document.addEventListener("click", event => document.querySelectorAll(".history-card details[open]").forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }));
  return {render: renderHistory, clear, showHistory, openEditor, visibleFiles};
})();
