'use strict';
// voice: the voice bridge (bridge.py, harness_seam.js, mac_client.py) and its guard
// half. While a harness task holds the executor lock, the seam sets
// state/voice-notools.flag and this module blocks every tool call of the voice
// session (env HARNESS_VOICE=1). The executor lock itself is core (see README).
// The flag file sits in state/ itself, not in state/m/voice/: a documented
// exception (docs/MODULES.md), because the seam process writes it outside any ctx.
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');

module.exports = {
  contract: 2,
  name: 'voice',
  hookTimeoutMs: 1000, // beforeTool is a cheap synchronous check
  description: 'Voice bridge guard half: a voice session gets no tools while a harness task is running.',
  beforeTool() {
    if (process.env.HARNESS_VOICE === '1' && fs.existsSync(path.join(J.STATE, 'voice-notools.flag')))
      return ['voice_busy', 'a harness task is running; this voice turn has no tools'];
    return null;
  },
};
