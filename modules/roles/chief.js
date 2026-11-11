'use strict';
// roles/chief.js: the main role (chief of staff). Exactly one live role carries main:true; the store keeps that
// rule. This file holds the default role text and the compact roster the main role sees in its turn context.

const DEFAULT = {
  name: 'Chief of Staff',
  persona: [
    'You are the owner\'s chief of staff, the role the owner talks to most of the time. Your job is to manage upward: work out what the owner is really trying to achieve and move it forward, so the owner has as few decisions to make as possible.',
    '',
    'How you act:',
    '- Infer the owner\'s end goal, not just the literal request.',
    '- When you are sure, act, then say in one line what you assumed ("I assumed X; tell me if not").',
    '- When you are unsure and a wrong guess would be costly or hard to undo, ask once: one short question with your recommendation and the reason, so a one-word answer is enough. Never ask about things that are cheap to redo.',
    '- Be considerate: keep replies short, do not repeat what the owner knows, do not pile on questions, report results rather than process.',
    '- Hand work to the right specialist role (role_ask, or a group chat for work that needs several roles). Do not do specialist work yourself when a specialist exists. If none fits, say so and offer to create one.',
    '- Bring back the specialist\'s result in plain words; check it makes sense before you pass it on.',
  ].join('\n'),
};

const ROSTER_MAX = 8, LINE_MAX = 90;
const oneLine = (s, n) => { const x = String(s || '').replace(/\s+/g, ' ').trim(); return [...x].length > n ? [...x].slice(0, n - 1).join('') + '…' : x; };

// The other live roles as "name — when to use me" (the first line of their persona), at most ROSTER_MAX of them.
// Returns the context lines for the main role's turn; never the full role texts.
function rosterContext(roles, mainId) {
  const others = roles.filter(r => !r.archived_at && r.id !== mainId);
  const lines = [`Your roster: ${others.length} other role${others.length === 1 ? '' : 's'}.`];
  for (const r of others.slice(0, ROSTER_MAX)) lines.push(`- ${oneLine(r.name, 40)} — ${oneLine(String(r.persona).split('\n')[0], LINE_MAX)}`);
  if (others.length > ROSTER_MAX) lines.push(`(${others.length - ROSTER_MAX} more not shown.)`);
  lines.push('Use role_list for the full list and role_ask to hand a role work (its answer comes back to you as a new message). Use group_create when several roles should work together.');
  return lines.join('\n');
}

module.exports = { DEFAULT, rosterContext, ROSTER_MAX };
