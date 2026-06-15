import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    // 15分後に自動非表示、ダブルタップで再表示（10分タイマー）
    @State private var showInfo = true
    @State private var hideTimer: Timer? = nil

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if showInfo {
                VStack(spacing: 16) {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(viewModel.isRunning ? "稼働中 :8080" : "起動中...", systemImage: "dot.radiowaves.left.and.right")
                            .font(.headline)
                            .foregroundStyle(.white)

                        infoRow("対応機種", viewModel.supportedDimensions)
                        infoRow("最新機能", viewModel.lastMetadataSummary)
                        infoRow("エラー", viewModel.lastError)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(viewModel.logger.entries.reversed()) { entry in
                                Text("[\(entry.timestamp.formatted(date: .omitted, time: .standard))] \(entry.message)")
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.white)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                .padding()
            }
        }
        .preferredColorScheme(.dark)
        .statusBarHidden(true)
        .onTapGesture(count: 2) {
            showInfo = true
            scheduleHide(after: 10 * 60)
        }
        .task {
            UIApplication.shared.isIdleTimerDisabled = true
            viewModel.start()
            scheduleHide(after: 15 * 60)
        }
    }

    private func scheduleHide(after seconds: TimeInterval) {
        hideTimer?.invalidate()
        hideTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { _ in
            withAnimation { showInfo = false }
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.gray)
            Spacer()
            Text(value).fontWeight(.medium).foregroundStyle(.white)
        }
    }
}
