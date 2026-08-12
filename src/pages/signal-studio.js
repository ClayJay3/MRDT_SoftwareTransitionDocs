import React from 'react';
import Layout from '@theme/Layout';
import SignalStudio from '@site/src/components/visuals/SignalStudio';

// A standalone route rather than a doc, because the studio wants the whole
// viewport and a doc page is a 900 px column with a sidebar next to it. The
// footer is dropped for the same reason: the layout is already sized to end at
// the bottom of the window.
export default function SignalStudioPage() {
  return (
    <Layout
      title="Signal Studio"
      description="Full-page RF link lab for the rover: real USGS terrain, a two-ray and knife-edge propagation model, and a library of antenna and radio configurations you can define, save and recall."
      noFooter
    >
      <SignalStudio />
    </Layout>
  );
}
