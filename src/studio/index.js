// The whole of the public build.
//
// docusaurus.studio.config.js points the pages plugin at this directory instead
// of src/pages, so this file is the index route of a site whose baseUrl is
// /signal-studio/. That is the trick that keeps the studio public without
// taking the bible with it: the public build has exactly one route in it, and
// its assets are emitted under the same prefix as the page, so one PathPrefix
// covers everything the public is allowed to have.
//
// The page itself is the one the docs site already had, imported rather than
// copied, so there is a single studio and not a public fork of one.
export {default} from '../pages/signal-studio';
