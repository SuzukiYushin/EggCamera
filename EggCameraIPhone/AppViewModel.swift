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
        let commandServer = CaptureCommandServer(pipeline: pipeline, logger: logger)

        self.logger = logger
        self.cameraController = cameraController
        self.transferClient = transferClient
        self.pipeline = pipeline
        self.commandServer = commandServer
    }

    func start() {
        UIApplication.shared.isIdleTimerDisabled = true
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
