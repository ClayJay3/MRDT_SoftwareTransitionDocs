// @ts-check
//
// The public half of docs.craysoftware.com.
//
// The site is one Docusaurus project but two builds, because the studio is
// public and the bible is not, and a single build cannot be both. Docusaurus
// compiles every doc page into a JavaScript chunk under /assets/js/, and
// main.js carries the map from route to chunk. Serving /assets/ to the public
// so that the studio's own scripts load would therefore serve the bible's prose
// to anyone who reads that map — the login page would still be there, and would
// no longer be protecting anything.
//
// So this build exists: the same project with the docs plugin switched off and
// a baseUrl of /signal-studio/, which puts the page and every asset it needs
// under one prefix. Traefik makes that prefix public and leaves the rest of the
// host behind Authentik. The public container holds no doc content to leak,
// rather than holding it behind a rule that has to be got right.
//
//   npm run build         → the bible, /assets/..., behind Authentik
//   npm run build:studio  → the studio, /signal-studio/assets/..., public
//
// src/pages/signal-studio.js stays in the docs build too, so `npm start` still
// serves the studio at /signal-studio during development. In production the
// public router wins that path, and the docs copy is never reached.

import base from './docusaurus.config.js';

/** @type {import('@docusaurus/types').Config} */
const config = {
  ...base,

  // Both the page and its assets. Everything this build emits is addressed
  // under here, which is what makes the public rule a single PathPrefix.
  baseUrl: '/signal-studio/',

  // The docs build still calls itself missourimrdt.github.io. This one is
  // genuinely reachable without a login, so its canonical and og: URLs should
  // say where it actually is.
  url: 'https://docs.craysoftware.com',

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        // The point of the exercise: no docs plugin, so not one line of the
        // bible is compiled into this bundle.
        docs: false,
        blog: false,
        // src/studio holds exactly one page, and it becomes the index route.
        pages: {path: 'src/studio'},
        theme: {customCss: './src/css/custom.css'},
      }),
    ],
  ],

  themeConfig: {
    ...base.themeConfig,
    navbar: {
      ...base.themeConfig.navbar,
      // The docs sidebar item cannot be here: there is no docs plugin to
      // resolve it against, and a link into the bible is a link to a login
      // prompt anyway. The one link out is the bible's front door, for the
      // people who do have an account.
      items: [
        {href: 'https://docs.craysoftware.com/', label: 'Software Bible', position: 'right'},
        {href: 'https://github.com/MissouriMRDT', label: 'GitHub Org', position: 'right'},
      ],
    },
  },
};

export default config;
