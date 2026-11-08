'use strict';
// voice: the voice bridge (bridge.py, harness_seam.js, mac_client.py) and its guard
// half. While a harness task holds the executor lock, the seam sets
// state/voice-notools.flag and this module blocks every tool call of the voice
// session (env HARNESS_VOICE=1). The executor lock itself is core (see README).
const fs = require('fs');
const path = require('path');
const J = require('../../lib/journal');

module.exports = {
  name: 'voice',
  beforeTool() {
    if (process.env.HARNESS_VOICE === '1' && fs.existsSync(path.join(J.STATE, 'voice-notools.flag')))
      return ['voice_busy', 'a harness task is running; this voice turn has no tools'];
    return null;
  },
};
