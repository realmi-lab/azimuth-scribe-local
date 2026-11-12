// Native window uses the same history workspace as localhost.
const initialPanelPage = new URLSearchParams(location.search).get("panel");
if (initialPanelPage) {
  document.body.dataset.panel = "workspace";
  let currentNativePage = null;
  window.showPanelPage = page => {
    if (currentNativePage === page) return;
    currentNativePage = page;
    document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
    if (page === "settings") {
      location.hash = "settings";
      refresh();
    } else if (page === "workspace" || page === "files") {
      window.ScribeHistory?.showHistory();
    }
  };
  window.showPanelPage(initialPanelPage);
}
