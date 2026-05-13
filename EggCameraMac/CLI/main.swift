import Foundation

enum RuntimeHolder {
    @MainActor static var runtime: AppRuntime?
}

Task { @MainActor in
    let runtime = AppRuntime()
    RuntimeHolder.runtime = runtime
    runtime.start()
}

RunLoop.main.run()
