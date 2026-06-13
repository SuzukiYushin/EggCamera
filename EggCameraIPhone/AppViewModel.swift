import Foundation
import SwiftUI
import UIKit

@MainActor
final class AppViewModel: ObservableObject {
    @Published var isRunning = false
    @Published var lastMetadataSummary = "-"
    @Published var lastError = "-"
    @Published var supportedDimensions = "-"

    let logger: AppLogger

    private let transferClient: TransferClient
    private let pipeline: CapturePipeline
    private let commandServer: CaptureCommandServer
    private let cameraController: CameraController

    init() {
        let logger = AppLogger()
        let cameraController = CameraController(logger: logger)
        let transferClient = TransferClient(logger: logger)
        let pipeline = CapturePipeline(cameraController: cameraController,
                                       transferClient: transferClient,
                                       logger: logger)
        let commandServer = CaptureCommandServer(pipeline: pipeline, cameraController: cameraController, logger: logger)

        self.logger = logger
        self.cameraController = cameraController
        self.transferClient = transferClient
        self.pipeline = pipeline
        self.commandServer = commandServer
    }

    func start() {
        // 自動ロックは無効のまま（端末をロックさせない）。ただしこの画面は
        // 誰も見ない（プレビューは /frame で iPad に送る）ので、消灯して
        // 電力・発熱・OLED焼き付きを抑える。整備時は手動で明るさを上げられる。
        UIApplication.shared.isIdleTimerDisabled = true
        UIScreen.main.brightness = 0
        Task {
            do {
                try await cameraController.startSession()
                try commandServer.start()
                supportedDimensions = cameraController.supportedDimensionsSummary()
                isRunning = true
                logger.log("AppViewModel started supported=\(supportedDimensions)")
            } catch {
                lastError = error.localizedDescription
                logger.log("Startup failed error=\(error.localizedDescription)")
            }
        }
    }
}
