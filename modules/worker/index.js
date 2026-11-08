'use strict';
// worker: manifest only. The worker is a separate process (worker.js, started on the
// worker machine) that pulls jobs from the server; it adds no hooks to the harness
// engine, so on the main machine switching this on changes nothing (runsOn: worker).
// Its bearer token lives in an owner-only file (setup.js token), not in config.
// worker.js reads the "worker" config section itself; this schema validates it at load.
module.exports = {
  contract: 1,
  name: 'worker',
  description: 'Pull-queue worker process: runs jobs the server queues, inside one work folder.',
  runsOn: 'worker',
  dependsOn: ['guard-base', 'guard-private-rules', 'checkpoint'], // the worker's policy and checkpoints use their apis
  settings: {
    server: { type: 'string', default: '', description: 'server URL, e.g. http://192.0.2.10:7420' },
    work_dir: { type: 'string', default: '', description: 'absolute folder the worker may write; required' },
    deny: { type: 'object', default: {}, description: 'extra deny rules for the worker policy' },
    daily_cap: { type: 'integer', default: 50, min: 0, description: 'jobs per day, 0 = none' },
    backoff_ms: { type: 'array', items: 'number', default: [1000, 30000], description: '[min, max] retry wait' },
    token_file: { type: 'string', default: '', description: 'owner-only file holding the token; empty = the default location' },
    heartbeat_ms: { type: 'integer', default: 10000, min: 100, description: 'progress heartbeat interval' },
    max_run_ms: { type: 'integer', default: 3600000, min: 1000, description: 'longest single job run' },
    id: { type: 'string', default: '', description: 'fixed worker id; empty = generated' },
  },
};
