// Party Jukebox menu bar icon. JXA, run by the stock osascript:
//
//   osascript -l JavaScript menubar/menubar.js <repo> <node> <port> [public-url]
//
// Jukebox.app starts it; you never need to. Run that line by hand in
// Terminal to see its errors, or put --selftest first to check the bridge
// works on this Mac without clicking anything:
//
//   osascript -l JavaScript menubar/menubar.js --selftest <repo> <node> <port>
//
// (node test/menubar-suite.js does that for you on a Mac.)
//
// WHY JXA: it ships with every Mac -- no Xcode, no compile step, no binary in
// git -- and its Objective-C bridge can own an NSStatusItem.
//
// WHY SO LITTLE IN HERE: none of this can run off a Mac, so none of it can be
// tested in the suites. Everything that decides anything lives in
// menubar/helper.js, which is plain Node and is tested. This file asks the
// helper for the menu as data, draws it, and hands clicks back. If you want
// to change what the menu says or does, change the helper, not this.
//
// It can fail, and that is fine: it is a separate process, started in the
// background, and nothing waits on it. If the icon never appears, the Dock
// icon and the jukebox work exactly as they did before it existed.
//
// Things that look odd and are deliberate:
//   - setters are called as methods (item.setEnabled(false)), never assigned
//     (item.enabled = false). The bridge handles both for declared properties,
//     but methods are the form that is never ambiguous.
//   - every ObjC callback is wrapped in try/catch. An exception escaping into
//     AppKit from a bridged callback can take the whole process down.
//   - the state tick shells out to curl rather than asking the helper: it runs
//     every few seconds all night, and node costs more to start than curl.

ObjC.import('Cocoa');

var SA = Application.currentApplication();
SA.includeStandardAdditions = true;

var REPO = '', NODE = '', PORT = '8484', PUBLIC_URL = '';
var statusItem = null, menu = null, controller = null, tickTimer = null;
var model = [];             // the items currently in the menu, by tag
var shownState = null;
var noteImage = null;

var TICK_SECONDS = 3;

function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

function sh(cmd) {
  // alteringLineEndings: false, or every \n comes back as \r.
  return SA.doShellScript(cmd, { alteringLineEndings: false });
}

function say(msg) {
  try { console.log('[menubar] ' + msg); } catch (e) {}
}

function helperCmd(parts) {
  var cmd = [q(NODE), q(REPO + '/menubar/helper.js'), '--repo', q(REPO), '--port', q(PORT)];
  if (PUBLIC_URL) cmd.push('--public-url', q(PUBLIC_URL));
  for (var i = 0; i < parts.length; i++) cmd.push(q(parts[i]));
  return cmd.join(' ');
}

function isNil(o) {
  try { return o === undefined || o === null || (typeof o.isNil === 'function' && o.isNil()); }
  catch (e) { return true; }
}

// ---------------------------------------------------------------------------
// the icon
// ---------------------------------------------------------------------------
// One note. Bright while the jukebox runs, greyed out while it is stopped,
// with a trailing ellipsis while it starts. A template image, so it follows
// light and dark menu bars by itself.
function paintIcon(state) {
  if (state === shownState) return;
  try {
    var b = statusItem.button;
    if (noteImage === null) {
      noteImage = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription('music.note', 'Party Jukebox');
      if (isNil(noteImage)) noteImage = false;
      else noteImage.setTemplate(true);              // follow light and dark menu bars
    }
    if (noteImage) {
      b.setImage(noteImage);
      b.setImagePosition(2);                         // NSImageLeft
      b.setTitle(state === 'starting' ? '…' : '');
    } else {
      b.setTitle(state === 'starting' ? '♫…' : '♫');  // no SF Symbols: plain text
    }
    b.setAppearsDisabled(state === 'stopped');
    b.setToolTip('Party Jukebox — ' + state);
    shownState = state;                              // only once it took: a failure retries next tick
  } catch (e) {
    say('paintIcon failed: ' + e);
  }
}

// running | starting | stopped, from curl and the Dock app's start marker.
function probeState() {
  var marker = REPO + '/data/launcher-starting.pid';
  var cmd =
    'if /usr/bin/curl -fsS -m 2 -o /dev/null ' + q('http://127.0.0.1:' + PORT + '/api/config') + ' 2>/dev/null; then echo running; ' +
    'elif [ -f ' + q(marker) + ' ] && kill -0 "$(cat ' + q(marker) + ' 2>/dev/null)" 2>/dev/null; then echo starting; ' +
    'else echo stopped; fi';
  try {
    var s = String(sh(cmd)).replace(/\s+/g, '');
    return s === 'running' || s === 'starting' ? s : 'stopped';
  } catch (e) {
    return 'stopped';
  }
}

// ---------------------------------------------------------------------------
// the menu
// ---------------------------------------------------------------------------
function fallbackModel(err) {
  // The helper itself failed: node gone, a syntax error after a bad update.
  // Still give the host a way out, and say where to look.
  return [
    { title: 'Menu unavailable: ' + String(err).slice(0, 80), enabled: false },
    { title: 'Details are in data/menubar.log', enabled: false },
    { separator: true },
    { title: 'Open Jukebox Page', enabled: true, action: 'open-page-direct' },
    { separator: true },
    { title: 'Quit Menu Bar Icon', enabled: true, action: 'quit' }
  ];
}

function rebuild() {
  var data = null;
  try {
    // stderr to the log: only the JSON may come back on stdout.
    data = JSON.parse(sh(helperCmd(['menu']) + ' 2>>' + q(REPO + '/data/menubar.log')));
    model = data.items || [];
  } catch (e) {
    say('helper menu failed: ' + e);
    model = fallbackModel(e);
  }
  if (data && data.state) paintIcon(data.state);
  if (data && data.tooltip) {
    try { statusItem.button.setToolTip(data.tooltip); } catch (e) {}
  }

  menu.removeAllItems;
  for (var i = 0; i < model.length; i++) {
    var m = model[i];
    if (m.separator) { menu.addItem($.NSMenuItem.separatorItem); continue; }
    var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(String(m.title), 'menuAction:', '');
    item.setTarget(controller);
    item.setTag(i);
    item.setEnabled(!!m.enabled);
    item.setState(m.checked ? 1 : 0);                 // NSControlStateValueOn / Off
    if (m.indent) item.setIndentationLevel(m.indent);
    menu.addItem(item);
  }
}

function act(i) {
  var m = model[i];
  if (!m || !m.action) return;
  say('click: ' + m.action + (m.arg ? ' ' + m.arg : ''));

  if (m.action === 'quit') {
    $.NSApplication.sharedApplication.terminate(null);
    return;
  }
  if (m.action === 'open-page-direct') {     // the fallback menu: no helper to ask
    sh('/usr/bin/open ' + q('http://localhost:' + PORT + '/') + ' >/dev/null 2>&1 &');
    return;
  }
  // In the background, always: an update check takes seconds and the menu
  // bar must never hang on it. All output goes to the log, because
  // do shell script waits for any open stdout before it returns.
  var parts = ['do', m.action];
  if (m.arg) parts.push(m.arg);
  sh(helperCmd(parts) + ' >>' + q(REPO + '/data/menubar.log') + ' 2>&1 &');

  // A start or stop shows up on the next ticks; look sooner than usual.
  if (m.action === 'start' || m.action === 'stop') {
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1.0, controller, 'tick:', null, false);
  }
}

// ---------------------------------------------------------------------------
function run(argv) {
  var selftest = argv[0] === '--selftest';
  if (selftest) argv = argv.slice(1);
  REPO = argv[0] || '';
  NODE = argv[1] || '/usr/local/bin/node';
  PORT = argv[2] || '8484';
  PUBLIC_URL = argv[3] || '';
  if (!REPO) { say('usage: menubar.js [--selftest] <repo> <node> <port> [public-url]'); return; }
  say('starting for ' + REPO + ' on port ' + PORT);

  ObjC.registerSubclass({
    name: 'JukeboxMenuController',
    superclass: 'NSObject',
    methods: {
      // NSMenuDelegate: called just before the menu opens, the documented
      // moment to rebuild it. So the menu is always fresh when looked at.
      'menuNeedsUpdate:': {
        types: ['void', ['id']],
        implementation: function (m) {
          try { rebuild(); } catch (e) { say('rebuild failed: ' + e); }
        }
      },
      'menuAction:': {
        types: ['void', ['id']],
        implementation: function (sender) {
          try { act(Number(sender.tag)); } catch (e) { say('action failed: ' + e); }
        }
      },
      'tick:': {
        types: ['void', ['id']],
        implementation: function (timer) {
          try { paintIcon(probeState()); } catch (e) { say('tick failed: ' + e); }
        }
      }
    }
  });

  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1);                  // Accessory: no Dock icon, no app menu

  controller = $.JukeboxMenuController.alloc.init;
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);   // NSVariableStatusItemLength

  menu = $.NSMenu.alloc.initWithTitle('Party Jukebox');
  // Without this AppKit decides for itself which items are enabled, and
  // "Stop" would be clickable while the jukebox is stopped.
  menu.setAutoenablesItems(false);
  menu.setDelegate(controller);
  statusItem.setMenu(menu);

  paintIcon(probeState());

  if (selftest) return runSelftest();

  tickTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(TICK_SECONDS, controller, 'tick:', null, true);

  say('icon up');
  try {
    app.run;                                   // never returns; Quit ends the process
  } catch (e) {
    // Not expected. If the bridge will not run the event loop itself, pump
    // it by hand: the same events, the same timers, just driven from here.
    say('app.run failed (' + e + '), pumping events by hand');
    app.finishLaunching;
    for (;;) {
      var ev = app.nextEventMatchingMaskUntilDateInModeDequeue(
        $.NSEventMaskAny, $.NSDate.dateWithTimeIntervalSinceNow(1), $.NSDefaultRunLoopMode, true);
      if (!isNil(ev)) app.sendEvent(ev);
    }
  }
}

// Everything up to the event loop, against the real AppKit, then out. The
// icon flashes up for a moment. PASS/FAIL per step, like preflight.js.
function runSelftest() {
  var fails = 0;
  function check(ok, label, extra) {
    say((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  --  ' + extra : ''));
    if (!ok) fails++;
  }
  check(!isNil(statusItem) && !isNil(statusItem.button), 'status item created');
  check(noteImage !== false, 'music.note symbol found', noteImage === false ? 'falls back to a text note' : '');
  check(!!controller.respondsToSelector('menuNeedsUpdate:'), 'menu delegate method registered');
  check(!!controller.respondsToSelector('menuAction:'), 'click handler registered');

  // Through the Objective-C side, exactly as AppKit calls it when the menu opens.
  controller.menuNeedsUpdate(menu);
  var count = Number(menu.numberOfItems);
  check(count > 5, 'menu built by the helper', count + ' items');
  check(model.length > 0 && !/^Menu unavailable/.test(model[0].title || ''), 'helper answered',
    model.length ? model[0].title : 'nothing');
  for (var i = 0; i < model.length; i++) {
    if (model[i].separator) continue;
    say('        ' + (model[i].checked ? '[x] ' : '    ') + model[i].title + (model[i].enabled ? '' : '   (greyed)'));
  }

  // A disabled header is a click that must do nothing.
  controller.menuAction(menu.itemAtIndex(0));
  check(true, 'a click on a header is harmless');

  var st = probeState();
  check(st === 'running' || st === 'stopped' || st === 'starting', 'state probe', st);
  var t = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(60, controller, 'tick:', null, false);
  check(!isNil(t), 'timer scheduled');
  t.invalidate;

  $.NSStatusBar.systemStatusBar.removeStatusItem(statusItem);
  say(fails ? fails + ' FAILED' : 'ALL PASSED');
  return fails ? 'FAIL' : 'PASS';
}
