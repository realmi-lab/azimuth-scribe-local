import SwiftUI
import WebKit
import UniformTypeIdentifiers

/// Embedded web view for the large workspace (files, transcript, summary) and settings screens.
final class Workspace: NSObject, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let web: WKWebView
    let base: URL
    private(set) var page = ""
    private var ready = false
    var onVaultMessage: ([String: Any]) -> Void = { _ in }

    init(base: URL) {
        self.base = base
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        configuration.userContentController.add(self, name: "scribeVault")
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == base.scheme, origin.host == base.host,
              origin.port == base.port, let body = message.body as? [String: Any] else { return }
        onVaultMessage(body)
    }

    func setSession(_ token: String, completion: @escaping () -> Void) {
        guard let cookie = HTTPCookie(properties: [.name: "scribe_vault", .value: token, .domain: base.host!, .path: "/",
                                                  HTTPCookiePropertyKey("HttpOnly"): "TRUE", HTTPCookiePropertyKey("SameSite"): "Strict"]) else { return }
        web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            self?.web.reload()
            completion()
        }
    }

    func prepareLock(_ completion: @escaping () -> Void) {
        guard ready else { completion(); return }
        var completed = false
        let finish = { if !completed { completed = true; completion() } }
        web.callAsyncJavaScript("if (window.flushBeforeVaultLock) await window.flushBeforeVaultLock();", arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: finish)
    }

    func clearPrivate() {
        ready = false
        web.isHidden = true
        web.stopLoading()
        let store = web.configuration.websiteDataStore.httpCookieStore
        store.getAllCookies { [weak self] cookies in
            let group = DispatchGroup()
            for cookie in cookies {
                group.enter(); store.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main) {
                guard let self else { return }
                self.ready = false
                self.web.load(URLRequest(url: self.base.appending(queryItems: [URLQueryItem(name: "panel", value: self.page)])))
            }
        }
    }

    func report(_ message: String) {
        web.callAsyncJavaScript("window.dispatchEvent(new CustomEvent('vault-native-error', {detail: message}))", arguments: ["message": message], in: nil, in: .page) { _ in }
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
        web.isHidden = false
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
