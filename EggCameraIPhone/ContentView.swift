import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    var body: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Label(viewModel.isRunning ? "Running :8080" : "Starting...", systemImage: "dot.radiowaves.left.and.right")
                    .font(.headline)

                infoRow("対応候補", viewModel.supportedDimensions)
                infoRow("最終結果", viewModel.lastMetadataSummary)
                infoRow("エラー", viewModel.lastError)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(viewModel.logger.entries.reversed()) { entry in
                        Text("[\(entry.timestamp.formatted(date: .omitted, time: .standard))] \(entry.message)")
                            .font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding()
        .task {
            UIApplication.shared.isIdleTimerDisabled = true
            viewModel.start()
        }
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).fontWeight(.medium)
        }
    }
}
