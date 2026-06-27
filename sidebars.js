// @ts-check

/**
 * The MRDT Software Bible sidebar — explicitly ordered so the reading path
 * makes sense: start broad, learn the shared foundations everything depends on,
 * then dive per-subteam, then infra, then the roadmap of what's left.
 *
 * @type {import('@docusaurus/plugin-content-docs').SidebarsConfig}
 */
const sidebars = {
  bible: [
    {
      type: 'category',
      label: 'Start Here',
      collapsed: false,
      items: ['start/intro', 'start/the-role', 'start/big-picture'],
    },
    {
      type: 'category',
      label: 'Foundations',
      collapsed: false,
      items: [
        'foundations/rovecomm',
        'foundations/network',
        'foundations/babel',
        'foundations/gps',
        'foundations/github',
        'foundations/standards',
      ],
    },
    {
      type: 'category',
      label: 'The Subteams',
      collapsed: false,
      items: [
        'subteams/autonomy',
        'subteams/basestation',
        'subteams/simulator',
      ],
    },
    {
      type: 'category',
      label: 'Infrastructure',
      items: ['infra/infrastructure'],
    },
    {
      type: 'category',
      label: 'Roadmap',
      items: ['roadmap/roadmap'],
    },
    {
      type: 'category',
      label: 'Reference',
      items: ['reference/board-table', 'reference/links', 'reference/glossary'],
    },
  ],
};

export default sidebars;
