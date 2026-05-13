// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "EggCameraMac",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "EggCameraMac", targets: ["EggCameraMac"])
    ],
    targets: [
        .executableTarget(
            name: "EggCameraMac",
            path: ".",
            exclude: [
                "EggCameraMac.xcodeproj",
                "EggCameraMacApp.swift",
                "Info.plist",
                "Package.swift",
                "Logs",
                "ReceivedPhotos",
                "config.json",
                "project.yml"
            ],
            sources: [
                "AppLogger.swift",
                "AppRuntime.swift",
                "CaptureCommandClient.swift",
                "CaptureModels.swift",
                "ReceivedPhotoStore.swift",
                "RuntimeConfiguration.swift",
                "UploadReceiverServer.swift",
                "CLI/main.swift"
            ]
        )
    ]
)
