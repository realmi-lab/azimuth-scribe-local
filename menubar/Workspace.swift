import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// Embedded web view for the large workspace (files, transcript, summary) and settings screens.
final class Workspace: NSObject, WKUIDelegate, WKNavigationDelegate {
    let web = WKWebView()
    let base: URL
    private(set) var page = ""
    private var ready = false

    init(base: URL) {
        self.base = base
        super.init()
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
    }

    func show(_ page: String) {
        self.page = page
        if ready { displayPage() }
        else if !web.isLoading { web.load(URLRequest(url: base.appending(queryItems: [URLQueryItem(name: "panel", value: page)]))) }
    }

    private func displayPage() {
        web.callAsyncJavaScript("window.showPanelPage(page)", arguments: ["page": page], in: nil, in: .page) { _ in }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        displayPage()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        webView.reload()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(url?.scheme == base.scheme && url?.host == base.host && url?.port == base.port && (url?.path == "/" || url?.path == "") ? .allow : .cancel)
    }

    // "파일 추가" inside the workspace uses an <input type=file>; WebKit needs a native picker.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let picker = NSOpenPanel()
        picker.allowedContentTypes = ["wav","mp3","m4a","flac","ogg","aac","webm","mp4","aiff","aif"].compactMap { UTType(filenameExtension: $0) }
        picker.allowsMultipleSelection = parameters.allowsMultipleSelection
        picker.begin { response in
            completionHandler(response == .OK ? picker.urls : nil)
        }
    }
}

struct WorkspacePane: NSViewRepresentable {
    let workspace: Workspace
    let page: String
    func makeNSView(context: Context) -> WKWebView { workspace.show(page); return workspace.web }
    func updateNSView(_ view: WKWebView, context: Context) {
        if workspace.page != page { workspace.show(page) }
    }
}
