'use strict';
// app-ui: a React chat app for the dantomation server (a port of the OpenMausBot UI).
// Off by default. Core serves the built app from ui/ at /m/app-ui/ui/; the routes below are
// the app's API (snapshot, history, send). Area packages add routes under adapter/areas/.
const routes = require('./adapter/routes');

module.exports = {
  contract: 2,
  name: 'app-ui',
  description: 'React chat app: bot list, threads, send. Built UI served at /m/app-ui/ui/.',
  runsOn: 'main',
  panels: [{ id: 'app', title: 'App', mount: 'page', entry: 'ui/panel.js' }],
  routes: routes.load(),
};
