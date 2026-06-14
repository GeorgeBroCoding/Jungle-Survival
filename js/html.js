import htm from 'htm';
import React from 'react';

// JSX-like template tag, no build step required.
// Usage: html`<mesh position=${[0,1,0]}><boxGeometry /></mesh>`
// Note: use <${Fragment}>...<//> instead of <>...</> - htm's empty-tag
// fragment shorthand isn't reliable when bound to React.createElement.
const html = htm.bind(React.createElement);
export default html;
