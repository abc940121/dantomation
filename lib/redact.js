'use strict';
// Secret-shaped strings. Core, because the guard dispatcher redacts every logged
// command, whichever modules are on.
const SECRET_LITERAL = /(sk-ant-[A-Za-z0-9_-]{8,}|sk-(proj-)?[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const redactFull = s => String(s).replace(new RegExp(SECRET_LITERAL.source, 'g'), '[REDACTED]').replace(/((?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
const redact = s => redactFull(s).slice(0, 300);
module.exports = { SECRET_LITERAL, redact, redactFull };
