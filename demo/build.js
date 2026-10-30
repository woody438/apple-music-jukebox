#!/usr/bin/env node
'use strict';

// Welds the real markup, the real stylesheet, the embedded fonts, the
// vendored QR library and the demo simulator into one self-contained file.
//
//   node demo/build.js
//
// Writes two things from the same inner content:
//   demo/jukebox-demo.html   complete document -- open it straight off disk
//   demo/artifact.html       fragment, for publishing as a Claude artifact
//                            (the platform supplies the document skeleton)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const indexHtml = read('public/index.html');
const fontsCss = read('public/fonts.css');
const styleCss = read('public/style.css');
const qrJs = read('public/vendor/qrcode.js');
const demoJs = read('demo/demo-app.js');
const library = read('demo/library.json');

// Take the real body, drop the tags that pull in external files.
const body = indexHtml
  .slice(indexHtml.indexOf('<body>') + '<body>'.length, indexHtml.indexOf('</body>'))
  .replace(/^\s*<script src="[^"]*"><\/script>\s*$/gm, '')
  .trim();

const DEMO_CSS = `
/* ---- demo-only ---------------------------------------------------------
   The cabinet is a deliberately single-look design: one dark palette, set
   explicitly, so it reads the same whatever theme the page is viewed in. */
:root { color-scheme: dark; }

/* The real app owns the whole window and uses 100dvh. Hosted in a frame it
   has to fit the frame instead, or the bottom of the cabinet is cut off. */
html, body { height: 100%; }
.cabinet { height: 100%; }
@media (max-width: 820px), (orientation: portrait) and (max-width: 1100px) {
  .cabinet { height: auto; min-height: 100%; }
}

.demobar {
  position: fixed;
  left: max(10px, env(safe-area-inset-left, 0px));
  bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  z-index: 80;
  width: min(300px, calc(100vw - 20px));
  font-size: 12px;
}
.demotag {
  padding: 5px 11px;
  font-size: 10px; font-weight: 700; letter-spacing: .22em;
  color: #241a00; background: var(--neon-amber);
  border: none; border-radius: 6px;
  box-shadow: 0 3px 10px rgba(0,0,0,.6);
}
.demobar.open .demotag { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.demobody {
  padding: 11px 13px 13px;
  color: rgba(255,255,255,.82);
  background: #15181d;
  border: 1px solid var(--neon-amber);
  border-radius: 0 8px 8px 8px;
  box-shadow: 0 10px 30px rgba(0,0,0,.7);
}
.demobody p { margin: 0 0 9px; line-height: 1.45; }
.demobody p.dim { margin: 9px 0 0; color: rgba(255,255,255,.5); }
.demorow { display: flex; align-items: center; gap: 6px; margin-top: 7px; }
.demorow span { font-size: 10px; letter-spacing: .16em; color: rgba(255,255,255,.5); }
.demorow button {
  flex: 0 0 auto;
  padding: 6px 11px; font-size: 12px; color: #fff;
  background: #2b313a; border: 1px solid #434c58; border-radius: 6px;
}
.demorow button.on { background: var(--neon-amber); border-color: var(--neon-amber); color: #241a00; font-weight: 700; }
#demoEnd { flex: 1 1 auto; }

@media (max-width: 820px), (orientation: portrait) and (max-width: 1100px) {
  .demobar { bottom: calc(84px + env(safe-area-inset-bottom, 0px)); }
}
`;

const inner = `<title>Party Jukebox Demo</title>
<style>
${fontsCss}
${styleCss}
${DEMO_CSS}
</style>

${body}

<script>
${qrJs}
</script>
<script>
var DEMO_LIBRARY = ${library};
</script>
<script>
${demoJs}
</script>
`;

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2a0a13">
${inner}
</head>
</html>
`;

fs.writeFileSync(path.join(ROOT, 'demo/jukebox-demo.html'), standalone);
fs.writeFileSync(path.join(ROOT, 'demo/artifact.html'), inner);

const kb = (s) => (Buffer.byteLength(s) / 1024).toFixed(0) + ' KB';
console.log(`demo/jukebox-demo.html  ${kb(standalone)}  (standalone, open from disk)`);
console.log(`demo/artifact.html      ${kb(inner)}  (fragment, for publishing)`);
