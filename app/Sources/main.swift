import AppKit

// No storyboard and no nib: the app is a Dock icon, a menu bar note and the
// server behind them, so it is assembled here. Top-level code runs on the
// main thread; assumeIsolated says so to the compiler.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate                 // a weak reference: something must keep it alive
    app.setActivationPolicy(.regular)       // in the Dock as well as the menu bar
    withExtendedLifetime(delegate) { app.run() }
}
