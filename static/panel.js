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
    "save-transcript":"저장…", "save-summary":"저장…", "copy-button":"복사",
    "th-name":"파일 이름", "th-duration":"길이", "th-status":"상태",
    "save-note":"Results 폴더에 저장합니다. ⋯ → 저장 결과 폴더 열기에서 볼 수 있습니다.",
    "settings-title":"모델 및 음성 인식 설정"
  })) $(id).textContent = label;
  $("transcript").placeholder = "받아쓰기 결과가 여기에 표시됩니다. 잘못 인식된 부분은 직접 고칠 수 있습니다.";
  $("help-button").onclick = () => showInfo("Local LLM Encoder 사용 방법", `
    <h3>1. 녹음하거나 파일 추가</h3><p>위쪽 <strong>녹음 시작</strong>(⌘R)으로 녹음하고, 끝내면 자동으로 받아쓰기를 시작합니다. 기존 음성 파일은 <strong>파일 추가</strong>나 끌어 놓기로 넣습니다.</p>
    <h3>2. 받아쓰기</h3><p>목록에서 파일을 선택하고 <strong>받아쓰기</strong>를 누르세요. 결과는 왼쪽 아래에 쌓이며 직접 고칠 수 있습니다. 같은 실수가 반복되면 <strong>일괄 수정</strong>에 규칙으로 저장하세요.</p>
    <h3>3. 요약</h3><p>서식을 고르고 <strong>요약 생성</strong>(⌘⏎)을 누르세요. 긴 회의는 자동으로 구간을 나눠 정리합니다. <strong>편집</strong>으로 결과를 고치고 <strong>저장…</strong>(⌘S)으로 Results 폴더에 저장합니다.</p>
    <h3>되돌리기</h3><p><strong>비우기</strong>, <strong>일괄 수정</strong>, 새 요약 생성 뒤에는 알림의 <strong>되돌리기</strong>로 이전 내용을 복구할 수 있습니다.</p>
    <h3>개인정보</h3><p>녹음·받아쓰기·요약은 모두 이 Mac 안에서만 처리합니다. 인터넷은 처음 모델을 받을 때만 씁니다.</p>`);
  document.querySelector('label[for="prompt-select"]').textContent = "서식";
  $("empty-files").querySelector("span").textContent = "파일을 끌어 놓거나 파일 추가를 누르세요.";
  $("summary").placeholder = "서식을 고르고 요약 생성을 누르세요.";
  $("panel-preferences").onclick = action(openSettings);
  $("panel-prompts").onclick = action(openPrompts);
  $("panel-replace").onclick = action(openReplace);
  $("panel-results").onclick = action(() => openStorage("results"));
  window.showPanelPage(initialPanelPage);
}
