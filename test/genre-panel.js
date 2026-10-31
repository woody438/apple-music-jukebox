// Genre settings panel checks. OPTIONAL: needs Playwright.
// Start the mock server first, then: node test/genre-panel.js
//
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.log('SKIP  genre panel: Playwright is not installed.'); process.exit(0); }
const BASE = process.env.JUKEBOX_URL || 'http://127.0.0.1:8484/';

let pass=0, fail=0;
const check=(ok,l,x)=>{console.log((ok?'PASS  ':'FAIL  ')+l+(x?'  --  '+x:''));ok?pass++:fail++;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const b=await chromium.launch({args:['--no-sandbox']});
  const p=await b.newContext({viewport:{width:1440,height:900}}).then(c=>c.newPage());
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(BASE,{waitUntil:'networkidle'});
  await p.waitForSelector('.strip'); await sleep(600);

  check(!(await p.locator('#genreSettings').isHidden()),'gear button shows for the host');
  const before = await p.locator('#genres .gbtn').count();

  await p.keyboard.down('Control'); await p.keyboard.down('Alt');
  await p.keyboard.press('KeyG');
  await p.keyboard.up('Alt'); await p.keyboard.up('Control');
  await sleep(400);
  check(!(await p.locator('#genrePanel').isHidden()),'control-option-G opens the panel');

  const totalGenres = await p.evaluate(()=>genres.length);
  check((await p.locator('#gpList input').count())===totalGenres,'panel lists every genre',totalGenres+' genres');
  check(/AUTOMATIC/.test(await p.textContent('#gpCount')),'starts on automatic',(await p.textContent('#gpCount')).trim());

  // tick everything
  await p.click('#gpAll'); await sleep(700);
  const all = await p.locator('#genres .gbtn').count();
  check(all === totalGenres+1,'ticking all puts every genre on the bar',all+' buttons (ALL + '+totalGenres+')');
  check(await p.evaluate(()=>Array.isArray(visibleGenres)),'client took the server selection');

  // untick everything -> just ALL and OTHER
  await p.click('#gpNone'); await sleep(700);
  const none = await p.evaluate(()=>Array.from(document.querySelectorAll('#genres .gbtn')).map(b=>b.dataset.genre));
  check(none.length===2 && none[0]==='__ALL__' && none[1]==='__OTHER__','unticking all leaves ALL + OTHER',none.join(', '));
  const otherCount = await p.evaluate(()=>Number(document.querySelector('#genres .gbtn[data-genre="__OTHER__"] .g-count').textContent.replace(/,/g,'')));
  const libCount = await p.evaluate(()=>rows.length);
  check(otherCount===libCount,'OTHER then holds the whole library',otherCount+' of '+libCount);

  // one genre only
  await p.evaluate(()=>{const cb=document.querySelector('#gpList input');cb.checked=true;cb.dispatchEvent(new Event('change'));});
  await sleep(700);
  const one = await p.evaluate(()=>Array.from(document.querySelectorAll('#genres .gbtn')).map(b=>b.dataset.genre));
  check(one.length===3,'ticking one genre gives ALL + it + OTHER',one.join(', '));

  // back to automatic
  await p.click('#gpAuto'); await sleep(700);
  check(await p.evaluate(()=>visibleGenres===null),'reset returns to automatic');
  check((await p.locator('#genres .gbtn').count())===before,'bar back to how it started');

  // the selection must reach a phone too
  const ph=await b.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}).then(c=>c.newPage());
  await ph.goto(BASE,{waitUntil:'networkidle'});
  await ph.waitForSelector('.strip'); await sleep(500);
  check(await ph.locator('#genreSettings').isHidden(),'phones never see the gear');
  await p.click('#gpNone'); await sleep(1200);
  const phoneBtns = await ph.evaluate(()=>Array.from(document.querySelectorAll('#genres .gbtn')).map(b=>b.dataset.genre));
  check(phoneBtns.length===2,'the phone followed the host selection',phoneBtns.join(', '));
  await p.click('#gpAuto'); await sleep(500);

  check(errs.length===0,'no JavaScript errors',errs.slice(0,2).join(' | ')||'clean');
  await p.keyboard.press('Escape'); await sleep(300);
  check(await p.locator('#genrePanel').isHidden(),'Escape closes the panel');
  await b.close();
  console.log('\n'+pass+' passed, '+fail+' failed');
  process.exit(fail?1:0);
})().catch(e=>{console.error('crashed:',e.message);process.exit(1)});
