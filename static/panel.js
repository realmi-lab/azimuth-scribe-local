const initialPanelPage = new URLSearchParams(location.search).get("panel");
if (initialPanelPage) {
  window.showPanelPage = page => {
    if (!["workspace", "files", "transcript", "summary", "settings"].includes(page)) return;
    if (document.body.dataset.panel !== page) {
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    }
    document.body.dataset.panel = page;
    $("panel-options").hidden = page !== "settings";
    refresh();
  };
  for (const [id, label] of Object.entries({
    "files-title":"녹음 파일", "transcript-title":"받아쓰기 편집", "summary-title":"요약",
    "add-button":"파일 추가", "delete-button":"목록에서 제거", "clear-button":"비우기",
    "save-transcript":"저장…", "save-summary":"저장…", "copy-button":"복사"
  })) $(id).textContent = label;
  document.querySelector('label[for="prompt-select"]').textContent = "서식";
  $("empty-files").querySelector("span").textContent = "파일을 끌어 놓거나 파일 추가를 누르세요.";
  $("summary").placeholder = "서식을 고르고 요약 생성을 누르세요.";
  $("panel-preferences").onclick = action(openSettings);
  $("panel-prompts").onclick = action(openPrompts);
  $("panel-results").onclick = action(() => openStorage("results"));
  window.showPanelPage(initialPanelPage);
}
