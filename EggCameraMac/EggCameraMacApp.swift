import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var runtime: AppRuntime?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.prohibited)
        let runtime = AppRuntime()
        self.runtime = runtime
        runtime.start()
    }
}

@main
struct EggCameraMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
