'use strict';
// routines: scheduled prompts. Owner-defined {id, bot, prompt, schedule}; a job enqueues a task for the
// bot through ctx.tasks when a routine is due. Off by default. See README.md and DECISIONS.md.
const { api, tick } = require('./engine');

// A validation/not-found error carries .status and becomes that answer; anything else is a core 500.
const wrap = fn => async ctx => {
  try { return await fn(ctx); }
  catch (e) { if (e && e.status) return { status: e.status, json: { error: e.message } }; throw e; }
};

module.exports = {
  contract: 2,
  name: 'routines',
  description: 'Scheduled prompts: cron subset or interval, per-day cap, missed runs fire once.',
  runsOn: 'main',
  routes: [
    { method: 'GET', path: '/routines', description: 'list routines and the usage today',
      handler: wrap(async c => ({ status: 200, json: { routines: await api.list(c), usage: await api.usage(c) } })) },
    { method: 'POST', path: '/routines', description: 'create {id, bot, prompt, schedule, paused?}',
      handler: wrap(async c => ({ status: 201, json: await api.create(c, c.body) })) },
    { method: 'GET', path: '/routines/:id', description: 'one routine',
      handler: wrap(async c => { const r = await api.get(c, c.params.id); return r ? { status: 200, json: r } : { status: 404, json: { error: 'not found' } }; }) },
    { method: 'PATCH', path: '/routines/:id', description: 'update {bot?, prompt?, schedule?, paused?}',
      handler: wrap(async c => ({ status: 200, json: await api.update(c, c.params.id, c.body) })) },
    { method: 'DELETE', path: '/routines/:id', description: 'delete',
      handler: wrap(async c => { await api.remove(c, c.params.id); return { status: 200, json: { ok: true } }; }) },
    { method: 'POST', path: '/routines/:id/pause', description: 'pause',
      handler: wrap(async c => ({ status: 200, json: await api.update(c, c.params.id, { paused: true }) })) },
    { method: 'POST', path: '/routines/:id/resume', description: 'resume (no backlog is fired)',
      handler: wrap(async c => ({ status: 200, json: await api.update(c, c.params.id, { paused: false }) })) },
    { method: 'POST', path: '/routines/:id/run', description: 'run now (counts toward the daily cap)',
      handler: wrap(async c => { const r = await api.runNow(c, c.params.id); return { status: r.fired ? 202 : (r.reason === 'daily_cap' ? 429 : 502), json: r }; }) },
  ],
  jobs: [{
    id: 'scheduler',
    // One pass at start (a run missed while the server was down fires once here), then every tick_s seconds.
    async start(ctx) {
      let busy = false;
      const pass = async () => {
        if (busy || ctx.signal.aborted) return;
        busy = true;
        try { await tick(ctx); }
        catch (e) { try { ctx.state.append({ type: 'routine_error', error: String(e && e.message).slice(0, 200) }); } catch { /* ignore */ } }
        finally { busy = false; }
      };
      await pass();
      const t = setInterval(pass, ctx.settings.tick_s * 1000);
      if (t.unref) t.unref();
      return () => clearInterval(t);
    },
  }],
  statusLines: async (J, ctx) => {
    try { const l = await api.list(ctx), u = await api.usage(ctx); return [`routines: ${l.length} defined (${l.filter(r => !r.paused).length} active), ${u.runs_today}/${u.cap} runs today`]; }
    catch { return ['routines: state unreadable']; }
  },
  settings: {
    max_runs_per_day: { type: 'integer', default: 24, min: 1, max: 10000, description: 'cap on routine runs per UTC day, all routines together (run-now counts)' },
    max_routines: { type: 'integer', default: 50, min: 1, max: 1000, description: 'most routines that may be defined' },
    max_prompt_chars: { type: 'integer', default: 4000, min: 1, max: 20000, description: 'longest routine prompt' },
    tick_s: { type: 'integer', default: 30, min: 1, max: 3600, description: 'how often the scheduler checks for due routines' },
  },
  api: { tick, ...api },
};
