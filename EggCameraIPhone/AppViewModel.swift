import Foundation
import SwiftUI

@MainActor
final class AppViewModel: ObservableObject {
    @Published var isRunning = false
    @Published var lastMetadataSummary = "-"
    @Published var lastError = "-"
    @Published var supportedDimensions = "-"

    let logger: AppLogger

    private let photoLibraryManager: PhotoLibraryManager
    private let transferClient: TransferClient
    private let pipeline: CapturePipeline
    private let commandServer: CaptureCommandServer
    private let cameraController: CameraController

    init() {
        let logger = AppLogger()
        let cameraController = CameraController(logger: logger)
        let photoLibraryManager = PhotoLibraryManager(logger: logger)
        let transferClient = TransferClient(logger: logger)
        let pipeline = CapturePipeline(cameraController: cameraController,
                                       photoLibraryManager: photoLibraryManager,
                                       transferClient: transferClient,
                                       logger: logger)
        let commandServer = CaptureCommandServer(pipeline: pipeline, logger: logger)

        self.logger = logger
        self.cameraController = cameraController
        self.photoLibraryManager = photoLibraryManager
        self.transferClient = transferClient
        self.pipeline = pipeline
        self.commandServer = commandServer
    }

    func start() {
        Task {
            do {
                let libraryAuthorized = await photoLibraryManager.requestAuthorization()
                guard libraryAuthorized else {
                    self.lastError = "Photo Library permission denied"
                    self.logger.log("Photo Library permission denied")
                    return
                }

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
