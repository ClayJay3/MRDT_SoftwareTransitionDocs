// @ts-check
import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'MRDT Software Bible',
  tagline: 'Everything the next Software Architect needs, and the why behind it.',
  favicon: 'img/favicon.png',

  future: {v4: true},

  url: 'https://missourimrdt.github.io',
  baseUrl: '/',
  organizationName: 'MissouriMRDT',
  projectName: 'Software_Bible',

  // Don't fail the build on a single bad link while we're actively drafting.
  onBrokenLinks: 'warn',

  // Mermaid diagrams everywhere.
  markdown: {
    mermaid: true,
    hooks: {onBrokenMarkdownLinks: 'warn'},
  },
  themes: ['@docusaurus/theme-mermaid'],

  i18n: {defaultLocale: 'en', locales: ['en']},

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          routeBasePath: '/', // docs are the site
          // editUrl: 'https://github.com/MissouriMRDT/Software_Bible/tree/main/',
        },
        blog: false,
        theme: {customCss: './src/css/custom.css'},
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/swoosh.png',
      colorMode: {
        defaultMode: 'dark',
        respectPrefersColorScheme: true,
      },
      mermaid: {
        theme: {light: 'neutral', dark: 'dark'},
      },
      navbar: {
        title: 'MRDT Software Bible',
        logo: {alt: 'MRDT rover swoosh', src: 'img/logo.svg', className: 'navbar-swoosh'},
        items: [
          {type: 'docSidebar', sidebarId: 'bible', position: 'left', label: 'The Bible'},
          {
            href: 'https://github.com/MissouriMRDT',
            label: 'GitHub Org',
            position: 'right',
          },
          {
            href: 'https://docs.themrdt.org/autonomy/',
            label: 'Autonomy Docs',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Repos',
            items: [
              {label: 'Autonomy_Software', href: 'https://github.com/MissouriMRDT/Autonomy_Software'},
              {label: 'Basestation_Software_Blazor', href: 'https://github.com/MissouriMRDT/Basestation_Software_Blazor'},
              {label: 'RoveComm_CPP', href: 'https://github.com/MissouriMRDT/RoveComm_CPP'},
              {label: 'Differential_GPS', href: 'https://github.com/MissouriMRDT/Differential_GPS'},
            ],
          },
          {
            title: 'Team',
            items: [
              {label: 'GitHub Org', href: 'https://github.com/MissouriMRDT'},
              {label: 'Project Boards', href: 'https://github.com/orgs/MissouriMRDT/projects'},
              {label: 'Join the Team', href: 'https://design.mst.edu'},
            ],
          },
        ],
        copyright: `Mars Rover Design Team, Missouri S&T. Built with Docusaurus. Rove hard.`,
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['cpp', 'csharp', 'python', 'bash', 'json', 'yaml'],
      },
      docs: {
        sidebar: {hideable: true, autoCollapseCategories: false},
      },
    }),
};

export default config;
