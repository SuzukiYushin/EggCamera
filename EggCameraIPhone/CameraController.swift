import AVFoundation
import Foundation
import ImageIO

final class CameraController: NSObject {
    private let session = AVCaptureSession()
    private let photoOutput = AVCapturePhotoOutput()
    private let sessionQueue = DispatchQueue(label: "com.eggcamera.iphone.camera")
    private weak var logger: AppLogger?
    private var device: AVCaptureDevice?
    private var activeDelegates: [PhotoCaptureDelegate] = []
    private let delegateLock = NSLock()

    init(logger: AppLogger) {
        self.logger = logger
        super.init()
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(sessionWasInterrupted),
                                               name: AVCaptureSession.wasInterruptedNotification,
                                               object: session)
        NotificationCenter.default.addObserver(self,
                                               selector: #selector(sessionInterruptionEnded),
                                               name: AVCaptureSession.interruptionEndedNotification,
                                               object: session)
    }

    @objc private func sessionWasInterrupted(_ notification: Notification) {
        let reason = notification.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int ?? -1
        Task { @MainActor in
            self.logger?.log("AVCaptureSession interrupted reason=\(reason)")
        }
    }

    @objc private func sessionInterruptionEnded(_ notification: Notification) {
        Task { @MainActor in
            self.logger?.log("AVCaptureSession interruption ended — restarting")
        }
        sessionQueue.async {
            if !self.session.isRunning {
                self.session.startRunning()
                Task { @MainActor in
                    self.logger?.log("AVCaptureSession restarted after interruption")
                }
            }
        }
    }

    func makePreviewLayer() -> AVCaptureVideoPreviewLayer {
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        return layer
    }

    func startSession() async throws {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    if !self.session.isRunning {
                        try self.configureSessionIfNeeded()
                        self.session.startRunning()
                        Task { @MainActor in
                            self.logger?.log("AVCaptureSession started")
                        }
                    }
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func stopSession() {
        sessionQueue.async {
            guard self.session.isRunning else { return }
            self.session.stopRunning()
            Task { @MainActor in
                self.logger?.log("AVCaptureSession stopped")
            }
        }
    }

    func supportedDimensionsSummary() -> String {
        guard let device else { return "-" }
        let values = device.activeFormat.supportedMaxPhotoDimensions
            .map { "\($0.width)x\($0.height)" }
            .sorted()
        return values.isEmpty ? "-" : values.joined(separator: ", ")
    }

    func capture(preferredWidth: Int?, preferredHeight: Int?) async throws -> (CaptureIntermediate, CaptureCandidate?) {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                guard self.session.isRunning else {
                    continuation.resume(throwing: CameraError.sessionNotRunning)
                    return
                }

                let candidate = self.chooseCandidate(preferredWidth: preferredWidth, preferredHeight: preferredHeight)
                let settings = self.makePhotoSettings(candidate: candidate)

                let delegate = PhotoCaptureDelegate(selectedDimensions: candidate?.dimensions) { [weak self] result in
                    self?.remove(delegate: result.delegate)
                    switch result.payload {
                    case .success(let payload):
                        continuation.resume(returning: (payload, candidate))
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }

                self.store(delegate: delegate)
                self.photoOutput.capturePhoto(with: settings, delegate: delegate)
                Task { @MainActor in
                    self.logger?.log("capturePhoto fired selected=\(self.describe(candidate?.dimensions)) deferredEnabled=\(candidate?.autoDeferredEnabled == true)")
                }
            }
        }
    }

    private func configureSessionIfNeeded() throws {
        guard session.inputs.isEmpty else { return }

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw CameraError.cameraUnavailable
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input), session.canAddOutput(photoOutput) else {
            throw CameraError.configurationFailed
        }

        session.addInput(input)
        session.addOutput(photoOutput)
        photoOutput.maxPhotoQualityPrioritization = .quality
        self.device = device

        if let format = device.formats.max(by: { maxArea($0) < maxArea($1) }) {
            try device.lockForConfiguration()
            device.activeFormat = format
            device.unlockForConfiguration()
        }

        if let largest = device.activeFormat.supportedMaxPhotoDimensions.max(by: { area($0) < area($1) }) {
            photoOutput.maxPhotoDimensions = largest
        }
    }

    private func chooseCandidate(preferredWidth: Int?, preferredHeight: Int?) -> CaptureCandidate? {
        guard let device else { return nil }
        let supported = device.activeFormat.supportedMaxPhotoDimensions
        guard !supported.isEmpty else { return nil }

        let selected: CMVideoDimensions
        if let preferredWidth, let preferredHeight, preferredWidth > 0, preferredHeight > 0 {
            let desiredLong = max(preferredWidth, preferredHeight)
            let desiredShort = min(preferredWidth, preferredHeight)
            selected = supported.min { lhs, rhs in
                score(lhs, desiredLong: desiredLong, desiredShort: desiredShort) <
                score(rhs, desiredLong: desiredLong, desiredShort: desiredShort)
            } ?? supported[0]
        } else {
            selected = supported.max(by: { area($0) < area($1) }) ?? supported[0]
        }

        let autoDeferredSupported: Bool
        if #available(iOS 17.0, *) {
            autoDeferredSupported = photoOutput.isAutoDeferredPhotoDeliverySupported
        } else {
            autoDeferredSupported = false
        }

        let autoDeferredEnabled = false
        return CaptureCandidate(dimensions: selected,
                                autoDeferredSupported: autoDeferredSupported,
                                autoDeferredEnabled: autoDeferredEnabled)
    }

    private func makePhotoSettings(candidate: CaptureCandidate?) -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings
        if photoOutput.availablePhotoCodecTypes.contains(.hevc) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.hevc])
        } else {
            settings = AVCapturePhotoSettings()
        }

        settings.photoQualityPrioritization = .quality
        if let candidate {
            settings.maxPhotoDimensions = candidate.dimensions
            if #available(iOS 17.0, *) {
                photoOutput.isAutoDeferredPhotoDeliveryEnabled = candidate.autoDeferredEnabled
            }
        }
        return settings
    }

    private func store(delegate: PhotoCaptureDelegate) {
        delegateLock.lock()
        activeDelegates.append(delegate)
        delegateLock.unlock()
    }

    private func remove(delegate: PhotoCaptureDelegate) {
        delegateLock.lock()
        activeDelegates.removeAll { $0 === delegate }
        delegateLock.unlock()
    }

    private func area(_ dimensions: CMVideoDimensions) -> Int {
        Int(dimensions.width) * Int(dimensions.height)
    }

    private func maxArea(_ format: AVCaptureDevice.Format) -> Int {
        format.supportedMaxPhotoDimensions.map(area).max() ?? 0
    }

    private func score(_ dimensions: CMVideoDimensions, desiredLong: Int, desiredShort: Int) -> Int {
        let longEdge = max(Int(dimensions.width), Int(dimensions.height))
        let shortEdge = min(Int(dimensions.width), Int(dimensions.height))
        return abs(longEdge - desiredLong) * 10 + abs(shortEdge - desiredShort)
    }

    private func describe(_ dimensions: CMVideoDimensions?) -> String {
        guard let dimensions else { return "-" }
        return "\(dimensions.width)x\(dimensions.height)"
    }
}

enum CameraError: Error, LocalizedError {
    case sessionNotRunning
    case cameraUnavailable
    case configurationFailed
    case photoDataUnavailable
    case deferredProxyUnavailable

    var errorDescription: String? {
        switch self {
        case .sessionNotRunning: return "Camera session is not running."
        case .cameraUnavailable: return "Back camera is unavailable."
        case .configurationFailed: return "Failed to configure camera session."
        case .photoDataUnavailable: return "Failed to generate photo data."
        case .deferredProxyUnavailable: return "Deferred photo proxy was unavailable."
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    struct CompletionResult {
        let delegate: PhotoCaptureDelegate
        let payload: Result<CaptureIntermediate, Error>
    }

    private let selectedDimensions: CMVideoDimensions?
    private let completion: (CompletionResult) -> Void
    private var hasCompleted = false

    init(selectedDimensions: CMVideoDimensions?,
         completion: @escaping (CompletionResult) -> Void) {
        self.selectedDimensions = selectedDimensions
        self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        guard !hasCompleted else { return }
        if let error {
            finish(.failure(error))
            return
        }

        guard let data = photo.fileDataRepresentation() else {
            finish(.failure(CameraError.photoDataUnavailable))
            return
        }

        let dimensions = imageDimensions(from: data) ?? selectedDimensions ?? CMVideoDimensions(width: 0, height: 0)
        finish(.success(.photo(data: data,
                               dimensions: dimensions,
                               fileType: "public.heic",
                               deferred: false)))
    }

    @available(iOS 17.0, *)
    func photoOutput(_ output: AVCapturePhotoOutput,
                     didFinishCapturingDeferredPhotoProxy deferredPhotoProxy: AVCaptureDeferredPhotoProxy?,
                     error: Error?) {
        guard !hasCompleted else { return }
        if let error {
            finish(.failure(error))
            return
        }

        guard let deferredPhotoProxy,
              let data = deferredPhotoProxy.fileDataRepresentation() else {
            finish(.failure(CameraError.deferredProxyUnavailable))
            return
        }

        let dimensions = imageDimensions(from: data) ?? selectedDimensions ?? CMVideoDimensions(width: 0, height: 0)
        finish(.success(.deferredProxy(data: data,
                                       selectedDimensions: dimensions,
                                       fileType: "public.heic")))
    }

    private func finish(_ payload: Result<CaptureIntermediate, Error>) {
        hasCompleted = true
        completion(CompletionResult(delegate: self, payload: payload))
    }

    private func imageDimensions(from data: Data) -> CMVideoDimensions? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else {
            return nil
        }

        return CMVideoDimensions(width: Int32(width), height: Int32(height))
    }
}
