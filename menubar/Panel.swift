import SwiftUI
import AppKit

struct Clip: Decodable, Identifiable {
    let id, name, status, transcript: String
    let summary, error: String?
}
struct Upload: Decodable { let files: [Clip] }

final class PanelModel: ObservableObject {
    @Published var connected = false
    @Published var working = false
    @Published var busy = false
    @Published var recording = false
    @Published var pending = false
    @Published var vaultLocked = true
    @Published var seconds = 0
    @Published var level = 0.0
    @Published var notice = ""
    var elapsed: String { String(format: "%02d:%02d", seconds / 60, seconds % 60) }
    var record: () -> Void = {}
    var start: () -> Void = {}
    var restart: () -> Void = {}
    var openFolder: (String) -> Void = { _ in }
    var quit: () -> Void = {}
}

/// Single large panel: the recorder in the title bar, the web workspace below.
/// Settings, help and the vault lock live in the workspace sidebar, so they are not repeated here.
struct RecorderPanel: View {
    static let size = NSSize(width: 1000, height: 760)
    @ObservedObject var model: PanelModel
    let workspace: Workspace
    private var locked: Bool { model.busy || model.working || model.recording || !model.connected }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .frame(height: 52)                  // matches the unified title bar
                .padding(.leading, 92)              // clear the traffic-light buttons
                .padding(.trailing, 14)
            Divider()
            if !model.notice.isEmpty {
                statusLine.padding(.horizontal, 16).padding(.vertical, 6)
                Divider()
            }
            if model.connected {
                WorkspacePane(workspace: workspace, page: "workspace")
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
        .frame(minWidth: 780, idealWidth: Self.size.width, maxWidth: .infinity,
               minHeight: 520, idealHeight: Self.size.height, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("scribe-panel")
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("Local LLM Encoder").font(.system(size: 13, weight: .semibold))
            Spacer()
            if model.recording {
                Text("● " + model.elapsed).font(.system(size: 12)).foregroundStyle(.red).monospacedDigit()
                ProgressView(value: model.level).controlSize(.small).frame(width: 70)
            }
            if model.connected || model.recording {
                Button(action: model.record) {
                    Label(model.recording ? "녹음 종료" : model.pending ? "보관된 녹음 다시 저장" : "녹음 시작",
                          systemImage: model.recording ? "stop.fill" : "mic.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(model.recording ? .red : .accentColor)
                .keyboardShortcut("r", modifiers: .command)
                .help(model.recording ? "녹음을 끝냅니다. 이어서 ‘요약하기’를 누르면 정리됩니다 (⌘R)"
                      : model.vaultLocked ? "보관함을 연 뒤 녹음할 수 있습니다" : "녹음 시작 (⌘R)")
                .disabled(!model.recording && (model.busy || model.working || model.vaultLocked))
            }
            Menu {
                Button("녹음 폴더 열기") { model.openFolder("data/Recordings") }
                Button("저장한 파일 폴더 열기") { model.openFolder("data/Results") }
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
            .accessibilityLabel("더 보기")
            .help("폴더 열기, 서버, 종료")
        }
    }

    /// Messages from the Mac side only (microphone permission, saving a recording).
    /// Job progress is shown by the workspace itself.
    private var statusLine: some View {
        HStack {
            if model.busy { ProgressView().controlSize(.small) }
            Text(model.notice).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
            Spacer()
        }
    }
}
