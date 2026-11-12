import AppKit
import SwiftUI
import AVFoundation
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
    let files: [Clip]
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
    private var window: NSPanel!
    private let panel = PanelModel()
    private lazy var workspace = Workspace(base: base)
    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var pending: URL { root.appendingPathComponent("data/pending-recording.m4a") }
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
            button.image = NSImage(systemSymbolName: "mic.circle", accessibilityDescription: "Local LLM Encoder")
            button.image?.isTemplate = true
            button.image?.size = NSSize(width: 20, height: 20)
            button.setAccessibilityLabel("Local LLM Encoder")
        }
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        statusItem.button?.imagePosition = .imageLeading
        panel.pending = FileManager.default.fileExists(atPath: pending.path)
        panel.record = { [weak self] in self?.recordAction() }
        panel.start = { [weak self] in self?.startServer(nil) }
        panel.restart = { [weak self] in self?.restartServer(nil) }
        panel.cancel = { [weak self] in self?.cancelWork(nil) }
        panel.openFolder = { [weak self] path in self?.openFolder(path) }
        panel.quit = { [weak self] in self?.quitEverything(nil) }
        window = makeWindow()
        let mainMenu = NSMenu()
        let appMenu = NSMenuItem()
        appMenu.submenu = makeMenu()
        mainMenu.addItem(appMenu)
        NSApp.mainMenu = mainMenu
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return false
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        return makeMenu(retain: false)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if panel.recording || panel.busy { return .terminateCancel }
        if quitting { return .terminateNow }
        if operation != nil || working {
            showError("현재 작업을 먼저 중단해 주세요.")
            return .terminateCancel
        }
        quitEverything(nil)
        return .terminateCancel
    }

    private func makeMenu(retain: Bool = true) -> NSMenu {
        let menu = NSMenu(title: "Local LLM Encoder")
        menu.autoenablesItems = false
        menu.delegate = self
        func item(_ title: String, _ selector: Selector?, tag: Int, key: String = "") {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: key)
            entry.target = self
            entry.tag = tag
            menu.addItem(entry)
        }
        item("상태 확인 중…", nil, tag: 2)
        item("", nil, tag: 3)
        menu.addItem(.separator())
        item("패널 열기", #selector(openProgram(_:)), tag: 10, key: "o")
        item("설정…", #selector(openSettings(_:)), tag: 11, key: ",")
        menu.addItem(.separator())
        item("서버 시작", #selector(toggleServer(_:)), tag: 20)
        item("서버 다시 시작", #selector(restartServer(_:)), tag: 22)
        item("현재 작업 중단", #selector(cancelWork(_:)), tag: 23)
        menu.addItem(.separator())
        let folders = NSMenu()
        for (title, selector) in [("녹음 폴더", #selector(openRecordings(_:))), ("저장 결과 폴더", #selector(openResults(_:))), ("서버 로그", #selector(openLog(_:)))] {
            let entry = NSMenuItem(title: title, action: selector, keyEquivalent: "")
            entry.target = self
            folders.addItem(entry)
        }
        let folderItem = NSMenuItem(title: "폴더 열기", action: nil, keyEquivalent: "")
        folderItem.submenu = folders
        menu.addItem(folderItem)
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
            case 2:
                entry.title = operation ?? (connected ? (working ? "● 작업 중 · localhost:\(base.port!)" : "● 실행 중 · localhost:\(base.port!)") : "○ 서버 중지됨")
                entry.isEnabled = false
            case 3:
                entry.title = connected ? (working ? state?.runtime.job?.message ?? "" : "Whisper \(state?.settings.whisper_model ?? "—") · \(state?.settings.llm_model ?? "—")") : lastError ?? "서버 시작 메뉴로 실행하세요."
                entry.isHidden = entry.title.isEmpty
                entry.isEnabled = false
            case 10: entry.isEnabled = operation == nil
            case 11: entry.isEnabled = operation == nil && connected
            case 20:
                entry.title = connected ? "서버 중지" : "서버 시작"
                entry.isEnabled = operation == nil && (!connected || !working)
            case 22: entry.isEnabled = operation == nil && connected && !working
            case 23: entry.isEnabled = operation == nil && working && state?.runtime.job?.status != "stopping"
            case 40: entry.isEnabled = operation == nil
            case 41: entry.isEnabled = operation == nil && !working
            default: break
            }
        }
    }

    private func updateMenus() {
        panel.connected = connected
        panel.working = working
        panel.job = state?.runtime.job?.message ?? ""
        panel.failed = state?.runtime.job?.status == "error"
        for menu in menus { update(menu) }
        statusItem?.button?.toolTip = operation ?? (connected ? "Local LLM Encoder · 실행 중" : "Local LLM Encoder · 서버 중지됨")
        statusItem?.button?.image = NSImage(systemSymbolName: connected ? "mic.circle.fill" : "mic.circle", accessibilityDescription: "Local LLM Encoder")
        statusItem?.button?.image?.isTemplate = true
        statusItem?.button?.image?.size = NSSize(width: 20, height: 20)
    }

    /// Fixed-size panel window (a popover jumps sideways when it is this wide near the screen edge).
    private func makeWindow() -> NSPanel {
        let host = NSHostingController(rootView: RecorderPanel(model: panel, workspace: workspace))
        host.sizingOptions = [.minSize]
        let window = NSPanel(contentRect: NSRect(origin: .zero, size: RecorderPanel.size),
                             styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
        window.contentViewController = host
        window.setContentSize(RecorderPanel.size)
        window.title = "Local LLM Encoder"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // An empty unified toolbar gives the 52pt title bar of modern Mac apps,
        // so the panel's own controls sit on the same line as the traffic lights.
        window.toolbar = NSToolbar(identifier: "scribe")
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = false
        window.isFloatingPanel = false
        window.hidesOnDeactivate = false
        window.becomesKeyOnlyIfNeeded = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        return window
    }

    @objc private func togglePanel() {
        if window.isVisible && window.isKeyWindow { window.orderOut(nil) } else { showPanel() }
    }

    private func showPanel() {
        if !window.isVisible { positionWindow() }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        refresh()
    }

    /// Drop the panel just below the menu-bar icon, kept inside that screen; centre it when the icon is not on screen.
    private func positionWindow() {
        if let button = statusItem.button, let barWindow = button.window, let screen = barWindow.screen {
            let icon = barWindow.convertToScreen(button.convert(button.bounds, to: nil))
            let visible = screen.visibleFrame
            if screen.frame.intersects(icon) && icon.midX > screen.frame.minX {
                let width = min(window.frame.width, visible.width - 16)
                let height = min(window.frame.height, visible.height - 14)
                let x = min(max(icon.midX - width / 2, visible.minX + 8), visible.maxX - width - 8)
                window.setFrame(NSRect(x: x, y: visible.maxY - height - 6, width: width, height: height), display: false)
                return
            }
        }
        window.center()
    }

    private func submit(_ path: String, _ body: [String: Any]) {
        guard !panel.busy, !working else { return }
        panel.busy = true
        panel.notice = ""
        request(path, body: body) { [weak self] _, error in
            guard let self else { return }
            self.panel.notice = error?.localizedDescription ?? ""
            self.panel.busy = false
            self.refresh()
        }
    }

    private func recordAction() {
        if let recorder {
            recorder.stop()
            self.recorder = nil
            meterTimer?.invalidate()
            statusItem.button?.title = ""
            panel.recording = false
            panel.pending = true
            uploadRecording()
            return
        }
        guard !panel.busy, connected, !working else { return }
        if panel.pending { uploadRecording(); return }
        panel.busy = true
        AVCaptureDevice.requestAccess(for: .audio) { granted in DispatchQueue.main.async {
            self.panel.busy = false
            guard granted else {
                self.panel.notice = "시스템 설정 → 개인정보 보호 및 보안 → 마이크에서 접근을 허용하세요."
                return
            }
            do {
                let recorder = try AVAudioRecorder(url: self.pending, settings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1])
                recorder.isMeteringEnabled = true
                guard recorder.record() else { throw NSError(domain: "Scribe", code: 2, userInfo: [NSLocalizedDescriptionKey:"마이크를 시작할 수 없습니다."]) }
                self.recorder = recorder
                self.panel.seconds = 0
                self.panel.notice = ""
                self.panel.recording = true
                self.meterTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
                    recorder.updateMeters()
                    self.panel.level = max(0, min(1, (Double(recorder.averagePower(forChannel: 0)) + 60) / 60))
                    self.panel.seconds = Int(recorder.currentTime)
                    self.statusItem.button?.title = " " + self.panel.elapsed
                }
            } catch { self.panel.notice = error.localizedDescription }
        } }
    }

    /// Multipart upload through curl; returns the clips the server created.
    private func postFiles(_ parts: [String], recording: Bool) throws -> [Clip] {
        let proc = Process(), pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        proc.arguments = ["--noproxy", "*", "-fsS", "-H", "X-Scribe-Request: 1"]
            + parts.flatMap { ["-F", "files=@" + $0] }
            + (recording ? ["-F", "recording=true"] : [])
            + [base.appendingPathComponent("api/files").absoluteString]
        proc.standardOutput = pipe
        try proc.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return [] }
        return (try? JSONDecoder().decode(Upload.self, from: data).files) ?? []
    }

    private func uploadRecording() {
        panel.busy = true
        panel.notice = "녹음 저장 중…"
        let file = pending
        DispatchQueue.global().async {
            let stamp = ISO8601DateFormatter().string(from: Date())
            do {
                guard let clip = try self.postFiles([file.path + ";filename=" + stamp + ".m4a"], recording: true).first else {
                    throw NSError(domain:"Scribe", code:3, userInfo:[NSLocalizedDescriptionKey:"녹음을 보관했습니다. 다시 저장해 주세요."])
                }
                try FileManager.default.removeItem(at: file)
                DispatchQueue.main.async {
                    self.panel.busy = false
                    self.panel.pending = false
                    self.panel.notice = ""
                    self.submit("api/transcribe?file_id=" + clip.id, [:])
                    self.refresh()
                }
            } catch { DispatchQueue.main.async {
                self.panel.busy = false
                self.panel.notice = error.localizedDescription
            } }
        }
    }

    private func request(_ path: String, body: [String: Any]? = nil, completion: @escaping (Data?, Error?) -> Void) {
        var request = URLRequest(url: URL(string: "/" + path, relativeTo: base)!.absoluteURL)
        if let body = body {
            request.timeoutInterval = 30
            request.httpMethod = "POST"
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("1", forHTTPHeaderField: "X-Scribe-Request")
        }
        session.dataTask(with: request) { data, response, error in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            DispatchQueue.main.async {
                completion(ok ? data : nil, error ?? (ok ? nil : NSError(domain: "Scribe", code: 1, userInfo: [NSLocalizedDescriptionKey: (data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["detail"] as? String) ?? "로컬 서버 응답을 확인할 수 없습니다."])))
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
        guard !working && !panel.recording && !panel.busy else { return }
        runLauncher(["--stop"], title: "서버 중지 중…")
    }

    @objc private func restartServer(_ sender: Any?) {
        guard !working && !panel.recording && !panel.busy else { return }
        runLauncher(["--stop"], title: "서버 다시 시작 중…") { [weak self] in
            self?.runLauncher([], title: "서버 시작 중…")
        }
    }

    @objc private func toggleServer(_ sender: Any?) {
        if connected { stopServer(sender) } else { startServer(sender) }
    }

    @objc private func openProgram(_ sender: Any?) {
        panel.screen = .workspace
        showPanel()
    }

    @objc private func openSettings(_ sender: Any?) {
        panel.screen = .settings
        showPanel()
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
        guard !panel.recording && !panel.busy else { return }
        quitting = true
        NSApp.terminate(nil)
    }

    @objc private func quitEverything(_ sender: Any?) {
        guard operation == nil && !working && !panel.recording && !panel.busy else { return }
        runLauncher(["--stop"], title: "종료 중…") { [weak self] in
            self?.quitting = true
            NSApp.terminate(nil)
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Local LLM Encoder"
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
