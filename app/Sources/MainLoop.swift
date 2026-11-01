import Foundation

/*
 * Runs a block on the main thread from the run loop itself, in every common
 * mode, rather than from the main dispatch queue.
 *
 * Found by CI's smoke test: a quit begun from inside a main-queue block (the
 * SIGTERM handler) left AppKit waiting, in a nested run loop, for the server
 * to stop -- and the "server stopped" callback, queued on the main dispatch
 * queue, never ran: that queue does not start a block while one of its own
 * is still running. The quit hung for good. The run loop's own blocks have
 * no such rule, and common modes include the modal one AppKit waits in.
 */
enum MainLoop {
    static func run(_ block: @escaping @MainActor () -> Void) {
        CFRunLoopPerformBlock(CFRunLoopGetMain(), CFRunLoopMode.commonModes.rawValue) {
            MainActor.assumeIsolated { block() }
        }
        CFRunLoopWakeUp(CFRunLoopGetMain())
    }

    /// A one-shot timer on the main run loop, in common modes.
    static func after(_ seconds: TimeInterval, _ block: @escaping @MainActor () -> Void) {
        let t = Timer(timeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { block() } }
        RunLoop.main.add(t, forMode: .common)
    }
}
