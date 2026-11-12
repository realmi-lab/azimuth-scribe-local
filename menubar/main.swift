import AppKit
import Foundation

struct Health: Decodable { let app: String; let root: String }
struct AppState: Decodable {
    struct Settings: Decodable { let whisper_model: String; let llm_model: String }
    struct Runtime: Decodable {
        struct Job: Decodable { let type: String; let status: String; let message: String }
        struct STT: Decodable { let state: String }
        struct Ollama: Decodable { let connected: Bool }
        let job: Job?
        let stt: STT
        let ollama: Ollama
    }
    let settings: Settings
    let runtime: Runtime
}

final class ScribeController: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?
    private var menus: [NSMenu] = []
    private var state: AppState?
    private var connected = false
    private var checking = false
    private var operation: String?
    private var lastError: String?
    private var quitting = false
    private var controlWindow: NSWindow?
    private let statusLabel = NSTextField(labelWithString: "상태 확인 중…")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let root: URL
    private let base: URL
    private let session: URLSession

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        root = URL(fileURLWithPath: info["ScribeProjectPath"] as? String ?? "").resolvingSymlinksInPath()
        base = URL(string: "http://127.0.0.1:\(info["ScribePort"] as? Int ?? 18765)")!
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        configuration.timeoutIntervalForResource = 4
        configuration.connectionProxyDictionary = [:]
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration)
        super.init()
    }

    private var working: Bool {
        guard let status = state?.runtime.job?.status else { return false }
        return connected && ["running", "stopping"].contains(status)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // A single controller owns both the status item and the Dock menu.
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "").first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            other.activate(options: [])
            quitting = true
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.regular)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "mic.circle", accessibilityDescription: "Azimuth Scribe")
            button.image?.isTemplate = true
            button.image?.size = NSSize(width: 20, height: 20)
            button.setAccessibilityLabel("Azimuth Scribe")
        }
        let menu = makeMenu()
        statusItem.menu = menu
        let mainMenu = NSMenu()
        let appMenu = NSMenuItem()
        appMenu.submenu = makeMenu()
        mainMenu.addItem(appMenu)
        NSApp.mainMenu = mainMenu
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
        showControlWindow()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showControlWindow()
        return false
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        return makeMenu(retain: false)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return .terminateNow }
        if operation != nil || working {
            showError("현재 작업을 먼저 중단해 주세요.")
            return .terminateCancel
        }
        quitEverything(nil)
        return .terminateCancel
    }

    private func makeMenu(retain: Bool = true) -> NSMenu {
        let menu = NSMenu(title: "Azimuth Scribe")
        menu.autoenablesItems = false
        menu.delegate = self
        func item(_ title: String, _ selector: Selector?, tag: Int, key: String = "") {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            entry.target = self
            entry.tag = tag
            menu.addItem(entry)
        }
        item("Azimuth Scribe", nil, tag: 1)
        item("상태 확인 중…", nil, tag: 2)
        item("", nil, tag: 3)
        menu.addItem(.separator())
        item("프로그램 열기…", #selector(openProgram(_:)), tag: 10, key: "o")
        item("환경설정…", #selector(openSettings(_:)), tag: 11, key: ",")
        menu.addItem(.separator())
        item("서버 시작", #selector(startServer(_:)), tag: 20)
        item("서버 중지", #selector(stopServer(_:)), tag: 21)
        item("서버 다시 시작", #selector(restartServer(_:)), tag: 22)
        item("현재 작업 중단", #selector(cancelWork(_:)), tag: 23)
        menu.addItem(.separator())
        item("녹음 폴더 열기", #selector(openRecordings(_:)), tag: 30)
        item("저장 결과 폴더 열기", #selector(openResults(_:)), tag: 31)
        item("서버 로그 보기", #selector(openLog(_:)), tag: 32)
        menu.addItem(.separator())
        item("컨트롤러만 종료 (서버 유지)", #selector(quitController(_:)), tag: 40)
        item("모두 종료", #selector(quitEverything(_:)), tag: 41, key: "q")
        update(menu)
        if retain { menus.append(menu) }
        return menu
    }

    func menuWillOpen(_ menu: NSMenu) {
        update(menu)
        refresh()
    }

    private func update(_ menu: NSMenu) {
        for entry in menu.items where !entry.isSeparatorItem {
            switch entry.tag {
            case 1: entry.isEnabled = false
            case 2:
                entry.title = operation ?? (connected ? (working ? "● 작업 중 · localhost:\(base.port!)" : "● 실행 중 · localhost:\(base.port!)") : "○ 서버 중지됨")
                entry.isEnabled = false
            case 3:
                entry.title = connected ? (working ? state?.runtime.job?.message ?? "" : "Whisper \(state?.settings.whisper_model ?? "—") · \(state?.settings.llm_model ?? "—")") : lastError ?? "서버 시작 메뉴로 실행하세요."
                entry.isHidden = entry.title.isEmpty
                entry.isEnabled = false
            case 10, 11: entry.isEnabled = operation == nil
            case 20: entry.isEnabled = operation == nil && !connected
            case 21, 22: entry.isEnabled = operation == nil && connected && !working
            case 23: entry.isEnabled = operation == nil && working && state?.runtime.job?.status != "stopping"
            case 30, 31, 32: entry.isEnabled = true
            case 40: entry.isEnabled = operation == nil
            case 41: entry.isEnabled = operation == nil && !working
            default: break
            }
        }
    }

    private func updateMenus() {
        for menu in menus { update(menu) }
        statusItem?.button?.toolTip = operation ?? (connected ? "Azimuth Scribe · 실행 중" : "Azimuth Scribe · 서버 중지됨")
        statusItem?.button?.image = NSImage(systemSymbolName: connected ? "mic.circle.fill" : "mic.circle", accessibilityDescription: "Azimuth Scribe")
        statusItem?.button?.image?.isTemplate = true
        statusItem?.button?.image?.size = NSSize(width: 20, height: 20)
        statusLabel.stringValue = operation ?? (connected ? "실행 중 · localhost:\(base.port!)" : "서버 중지됨")
        detailLabel.stringValue = connected ? (working ? state?.runtime.job?.message ?? "" : "Whisper \(state?.settings.whisper_model ?? "—") · \(state?.settings.llm_model ?? "—")") : lastError ?? "메뉴에서 서버를 시작할 수 있습니다."
    }

    private func showControlWindow() {
        if controlWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 470, height: 300),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Azimuth Scribe"
            window.isReleasedWhenClosed = false
            let stack = NSStackView()
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 17
            stack.translatesAutoresizingMaskIntoConstraints = false
            let heading = NSTextField(labelWithString: "Azimuth Scribe")
            heading.font = .systemFont(ofSize: 26, weight: .semibold)
            statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
            detailLabel.font = .systemFont(ofSize: 12)
            detailLabel.textColor = .secondaryLabelColor
            stack.addArrangedSubview(heading)
            stack.addArrangedSubview(statusLabel)
            stack.addArrangedSubview(detailLabel)
            let buttons = NSStackView()
            buttons.spacing = 9
            for (title, action) in [("프로그램 열기", #selector(openProgram(_:))),
                                    ("환경설정", #selector(openSettings(_:)))] {
                let button = NSButton(title: title, target: self, action: action)
                button.bezelStyle = .rounded
                buttons.addArrangedSubview(button)
            }
            stack.addArrangedSubview(buttons)
            let hint = NSTextField(wrappingLabelWithString: "상단 마이크 아이콘이나 Dock 아이콘의 우클릭 메뉴에서 서버를 제어하세요. 창을 닫아도 메뉴 막대에서 계속 실행됩니다.")
            hint.font = .systemFont(ofSize: 11)
            hint.textColor = .secondaryLabelColor
            stack.addArrangedSubview(hint)
            window.contentView!.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28),
                stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28),
                stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 25),
            ])
            window.center()
            controlWindow = window
        }
        controlWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateMenus()
    }

    private func request(_ path: String, body: [String: Any]? = nil, completion: @escaping (Data?, Error?) -> Void) {
        var request = URLRequest(url: base.appendingPathComponent(path))
        if let body = body {
            request.httpMethod = "POST"
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("1", forHTTPHeaderField: "X-Scribe-Request")
        }
        session.dataTask(with: request) { data, response, error in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            DispatchQueue.main.async {
                completion(ok ? data : nil, error ?? (ok ? nil : NSError(domain: "Scribe", code: 1, userInfo: [NSLocalizedDescriptionKey: "로컬 서버 응답을 확인할 수 없습니다."])))
            }
        }.resume()
    }

    private func refresh() {
        if checking || operation != nil { return }
        checking = true
        request("api/health") { [weak self] data, _ in
            guard let self = self else { return }
            guard let data = data, let health = try? JSONDecoder().decode(Health.self, from: data),
                  health.app == "azimuth-scribe-local", URL(fileURLWithPath: health.root).resolvingSymlinksInPath() == self.root else {
                self.connected = false
                self.state = nil
                self.checking = false
                self.updateMenus()
                return
            }
            self.request("api/state") { [weak self] data, _ in
                guard let self = self else { return }
                self.state = data.flatMap { try? JSONDecoder().decode(AppState.self, from: $0) }
                self.connected = self.state != nil
                self.checking = false
                if self.connected { self.lastError = nil }
                self.updateMenus()
            }
        }
    }

    private func runLauncher(_ arguments: [String], title: String, completion: (() -> Void)? = nil) {
        guard operation == nil else { return }
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("launcher.py").path) else {
            showError("프로젝트 폴더를 찾을 수 없습니다. 설치 프로그램을 다시 실행해 주세요.")
            return
        }
        operation = title
        updateMenus()
        let root = self.root, port = self.base.port!
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let process = Process(), output = Pipe()
            let python = root.appendingPathComponent(".venv/bin/python").path
            process.executableURL = URL(fileURLWithPath: FileManager.default.isExecutableFile(atPath: python) ? python : "/usr/bin/python3")
            process.arguments = [root.appendingPathComponent("launcher.py").path] + arguments
            process.currentDirectoryURL = root
            var environment = ProcessInfo.processInfo.environment
            environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (environment["PATH"] ?? "")
            environment["SCRIBE_PORT"] = String(port)
            environment["PYTHONUNBUFFERED"] = "1"
            process.environment = environment
            process.standardOutput = output
            process.standardError = output
            var failure: String?
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                if process.terminationStatus != 0 {
                    let message = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    failure = message.isEmpty ? "서버 제어에 실패했습니다 (종료 코드 \(process.terminationStatus))." : String(message.suffix(1600))
                }
            } catch { failure = error.localizedDescription }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.operation = nil
                if let failure = failure {
                    self.lastError = failure
                    self.updateMenus()
                    self.showError(failure)
                } else {
                    self.refresh()
                    completion?()
                }
            }
        }
    }

    @objc private func startServer(_ sender: Any?) {
        runLauncher([], title: "서버 시작 중…")
    }

    @objc private func stopServer(_ sender: Any?) {
        guard !working else { return }
        runLauncher(["--stop"], title: "서버 중지 중…")
    }

    @objc private func restartServer(_ sender: Any?) {
        guard !working else { return }
        runLauncher(["--stop"], title: "서버 다시 시작 중…") { [weak self] in
            self?.runLauncher([], title: "서버 시작 중…")
        }
    }

    private func openPage(fragment: String = "") {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.host = "localhost"
        components.fragment = fragment.isEmpty ? nil : fragment
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    @objc private func openProgram(_ sender: Any?) {
        if connected { openPage() }
        else { runLauncher([], title: "서버 시작 중…") { [weak self] in self?.openPage() } }
    }

    @objc private func openSettings(_ sender: Any?) {
        if connected { openPage(fragment: "settings") }
        else { runLauncher([], title: "서버 시작 중…") { [weak self] in self?.openPage(fragment: "settings") } }
    }

    @objc private func cancelWork(_ sender: Any?) {
        guard connected && working else { return }
        request("api/cancel", body: [:]) { [weak self] _, error in
            if let error = error { self?.showError(error.localizedDescription) }
            self?.refresh()
        }
    }

    private func openFolder(_ relative: String) {
        let folder = root.appendingPathComponent(relative)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            NSWorkspace.shared.open(folder)
        } catch { showError(error.localizedDescription) }
    }

    @objc private func openRecordings(_ sender: Any?) { openFolder("data/Recordings") }
    @objc private func openResults(_ sender: Any?) { openFolder("data/Results") }
    @objc private func openLog(_ sender: Any?) {
        let log = root.appendingPathComponent("data/server.log")
        if FileManager.default.fileExists(atPath: log.path) { NSWorkspace.shared.open(log) }
        else { showError("아직 서버 로그가 없습니다.") }
    }

    @objc private func quitController(_ sender: Any?) {
        quitting = true
        NSApp.terminate(nil)
    }

    @objc private func quitEverything(_ sender: Any?) {
        guard operation == nil && !working else { return }
        runLauncher(["--stop"], title: "종료 중…") { [weak self] in
            self?.quitting = true
            NSApp.terminate(nil)
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Azimuth Scribe"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "확인")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let application = NSApplication.shared
let controller = ScribeController()
application.delegate = controller
application.run()
