import AppKit

// No storyboard and no nib: the app is a Dock icon, a menu bar note and the
// server behind them, so it is assembled here.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)       // in the Dock as well as the menu bar
app.run()
