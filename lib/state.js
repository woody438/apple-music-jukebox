'use strict';

// Queue persistence. Small enough that a synchronous write is cheaper than
// the bug you get from an async one racing a crash.

const fs = require('fs');
const path = require('path');

function createStore(file) {
  const dir = path.dirname(file);
  const tmp = file + '.tmp';

  return {
    file,
    load() {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch (e) {
        return null;
      }
    },
    save(state) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Write-then-rename so a crash mid-write cannot leave a truncated file.
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, file);
      } catch (e) {
        // Losing the queue to disk is survivable; crashing the party is not.
      }
    },
    clear() {
      try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
    },
  };
}

module.exports = { createStore };
