import SwiftUI
import AppKit

struct Clip: Decodable, Identifiable {
    let id, name, status, transcript: String
    let summary, error: String?
}
struct Upload: Decodable { let files: [Clip] }

enum PanelScreen { case workspace, settings }

final class PanelModel: ObservableObject {
    @Published var screen: PanelScreen = .workspace
    @Published var connected = false
    @Published var working = false
    @Published var failed = false
    @Published var busy = false
    @Published var recording = false
    @Published var pending = false
    @Published var seconds = 0
    @Published var level = 0.0
    @Published var job = ""
    @Published var notice = ""
    var elapsed: String { String(format: "%02d:%02d", seconds / 60, seconds % 60) }
    var record: () -> Void = {}
    var start: () -> Void = {}
    var restart: () -> Void = {}
    var cancel: () -> Void = {}
    var openFolder: (String) -> Void = { _ in }
    var quit: () -> Void = {}
}

/// Single large panel: native recorder bar on top, embedded web workspace below.
struct RecorderPanel: View {
    static let size = NSSize(width: 880, height: 700)
    @ObservedObject var model: PanelModel
    let workspace: Workspace
    private var locked: Bool { model.busy || model.working || model.recording || !model.connected }

    private var statusText: String {
        model.recording ? "녹음 중" : model.working ? "작업 중" : model.connected ? "준비됨" : "서버 중지됨"
    }
    private var statusColor: Color {
        model.recording ? .red : model.working ? .orange : model.connected ? .green : .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .frame(height: 52)                  // matches the unified title bar
                .padding(.leading, 92)              // clear the traffic-light buttons
                .padding(.trailing, 14)
            Divider()
            if model.working || !model.notice.isEmpty || model.failed {
                statusLine.padding(.horizontal, 16).padding(.vertical, 6)
                Divider()
            }
            if model.connected {
                WorkspacePane(workspace: workspace, page: model.screen == .settings ? "settings" : "workspace")
                    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "power.circle").font(.system(size: 40)).foregroundStyle(.secondary)
                    Text("서버가 중지되어 있습니다.").font(.headline)
                    Button("서버 시작", action: model.start).buttonStyle(.borderedProminent).disabled(model.busy)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .ignoresSafeArea(.container, edges: .top)
        .background(Color(nsColor: .textBackgroundColor).ignoresSafeArea()) // clean solid white / dark
        .frame(minWidth: 720, idealWidth: Self.size.width, maxWidth: .infinity,
               minHeight: 520, idealHeight: Self.size.height, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("scribe-panel")
    }

    private var header: some View {
        HStack(spacing: 10) {
            if model.screen == .settings {
                Button { model.screen = .workspace } label: {
                    Image(systemName: "chevron.left").frame(width: 16)
                }.help("작업 공간으로 돌아가기")
                Text("설정").font(.system(size: 13, weight: .semibold))
            } else {
                Text("Local LLM Encoder").font(.system(size: 13, weight: .semibold))
            }
            Spacer()
            if model.recording {
                Text("● " + model.elapsed).font(.system(size: 12)).foregroundStyle(.red).monospacedDigit()
                ProgressView(value: model.level).controlSize(.small).frame(width: 70)
            }
            Button(action: model.connected || model.recording ? model.record : model.start) {
                Label(model.recording ? "녹음 종료하고 받아쓰기" : !model.connected ? "서버 시작" : model.pending ? "보관된 녹음 다시 저장" : "녹음 시작",
                      systemImage: model.recording ? "stop.fill" : model.connected ? "mic.fill" : "power")
            }
            .buttonStyle(.borderedProminent)
            .tint(model.recording ? .red : .accentColor)
            .disabled(!model.recording && (model.busy || model.working))
            HStack(spacing: 5) {
                Circle().fill(statusColor).frame(width: 6, height: 6)
                Text(statusText).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Menu {
                Button("설정…") { model.screen = .settings }.disabled(!model.connected)
                Divider()
                Button("녹음 폴더 열기") { model.openFolder("data/Recordings") }
                Button("저장 결과 폴더 열기") { model.openFolder("data/Results") }
                Divider()
                if model.connected {
                    Button("서버 다시 시작") { model.restart() }.disabled(locked)
                } else {
                    Button("서버 시작") { model.start() }.disabled(model.busy)
                }
                Button("모두 종료") { model.quit() }.disabled(model.recording || model.busy || model.working)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("메뉴")
        }
    }

    private var statusLine: some View {
        HStack {
            if model.working { ProgressView().controlSize(.small) }
            Text(model.notice.isEmpty ? model.job : model.notice)
                .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            Spacer()
            if model.working { Button("중단", action: model.cancel).controlSize(.small) }
        }
    }
}

