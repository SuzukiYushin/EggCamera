import Foundation

private struct CaptureTimeoutError: Error {}

@MainActor
final class AppRuntime {
    private let configuration: RuntimeConfiguration
    private let logger: AppLogger
    private let store: ReceivedPhotoStore
    private let commandClient = CaptureCommandClient()
    private lazy var receiverServer = UploadReceiverServer(port: configuration.callbackPort,
                                                           logger: logger,
                                                           store: store)
    private lazy var triggerServer: TriggerReceiverServer? = {
        guard let port = configuration.triggerPort else { return nil }
        return TriggerReceiverServer(port: port, logger: logger) { [weak self] triggerId in
            await self?.sendCapture(triggerId: triggerId)
        }
    }()
    private var loopTask: Task<Void, Never>?
    private var isSending = false

    init(configuration: RuntimeConfiguration = .load()) {
        self.configuration = configuration
        self.logger = AppLogger(logDirectory: configuration.resolvedLogsDirectory)
        self.store = ReceivedPhotoStore(directoryURL: configuration.resolvedReceivedPhotosDirectory,
                                       outputSize: configuration.outputSize,
                                       centerCropToExactSize: configuration.centerCropToExactSize,
                                       logger: logger)
    }

    func start() {
        do {
            try receiverServer.start()
            if let triggerServer {
                try triggerServer.start()
            }
            logger.log("Background receiver started callback=http://\(configuration.resolvedCallbackHost):\(configuration.callbackPort)/upload")
            logger.log("Capture target host=\(configuration.iphoneHost ?? "bonjour"):\(configuration.iphonePort) preferred=\(configuration.preferredWidth?.description ?? "-")x\(configuration.preferredHeight?.description ?? "-") interval=\(configuration.captureIntervalSeconds)")
            logger.log("Output processing size=\(configuration.outputWidth?.description ?? "-")x\(configuration.outputHeight?.description ?? "-") centerCrop=\(configuration.centerCropToExactSize)")
            logger.log("ReceivedPhotos directory=\(configuration.resolvedReceivedPhotosDirectory.path)")
            logger.log("Logs directory=\(configuration.resolvedLogsDirectory.path)")

            guard configuration.sendCaptureOnLaunch else {
                logger.log("SendCaptureOnLaunch is disabled")
                return
            }

            if configuration.captureIntervalSeconds > 0 {
                loopTask = Task { [weak self] in
                    guard let self else { return }
                    while !Task.isCancelled {
                        await self.sendCapture()
                        try? await Task.sleep(for: .seconds(configuration.captureIntervalSeconds))
                    }
                }
            } else {
                Task { [weak self] in
                    await self?.sendCapture()
                }
            }
        } catch {
            logger.log("Failed to start receiver error=\(error.localizedDescription)")
        }
    }

    private func sendCapture(triggerId: String = "-") async {
        guard !isSending else {
            logger.log("[\(triggerId)] Capture skipped because a request is already in flight")
            return
        }

        isSending = true
        defer { isSending = false }

        let callbackURL = "http://\(configuration.resolvedCallbackHost):\(configuration.callbackPort)/upload"
        logger.log("[\(triggerId)] Sending capture command callback=\(callbackURL)")

        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    try await self.commandClient.sendCapture(to: self.configuration.iphoneHost,
                                                            port: self.configuration.iphonePort,
                                                            callbackURL: callbackURL,
                                                            preferredWidth: self.configuration.preferredWidth,
                                                            preferredHeight: self.configuration.preferredHeight)
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(15))
                    throw CaptureTimeoutError()
                }
                try await group.next()
                group.cancelAll()
            }
            logger.log("[\(triggerId)] Capture command accepted by iPhone")
        } catch is CaptureTimeoutError {
            logger.log("[\(triggerId)] Capture command timed out — resetting")
        } catch {
            logger.log("[\(triggerId)] Capture command failed error=\(error.localizedDescription)")
        }
    }
}
