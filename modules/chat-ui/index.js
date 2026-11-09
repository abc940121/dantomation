'use strict';
// chat-ui: phone-first web chat for the dantomation server. Off by default.
// The module only declares its panel; core serves modules/chat-ui/ui/ as static files at
// /m/chat-ui/ui/ (registry.uiFile). The standalone page is /m/chat-ui/ui/index.html;
// ui/panel.js is the panel entry that mounts it inside another UI.
module.exports = {
  contract: 2,
  name: 'chat-ui',
  description: 'Phone-first web chat for the dantomation server.',
  runsOn: 'main',
  panels: [{ id: 'chat', title: 'Chat', mount: 'page', entry: 'ui/panel.js' }],
};
