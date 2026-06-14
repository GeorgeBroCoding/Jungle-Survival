import React, { Fragment, useEffect } from 'react';
import html from './html.js';
import { useGame } from './store.js';
import { registerInteractable } from './interactions.js';
import { RESOURCES } from './data.js';
import { Tree, Rock, Bush } from './World.js';

function ResourceNode({ node }) {
  const depleted = useGame((s) => !!s.depletedNodes[node.id]);

  useEffect(() => {
    if (depleted) return undefined;
    return registerInteractable({
      id: node.id,
      position: node.position,
      radius: 2.4,
      key: 'KeyF',
      label: `Gather ${RESOURCES[node.type].name}`,
      onInteract: () => useGame.getState().gatherNode(node),
    });
  }, [depleted]);

  if (depleted) return null;

  if (node.type === 'wood') return html`<${Tree} position=${node.position} scale=${1.1} />`;
  if (node.type === 'fiber') return html`<${Bush} position=${node.position} scale=${1.2} />`;
  if (node.type === 'stone') return html`<${Rock} position=${node.position} scale=${1.5} />`;
  return null;
}

export default function Resources() {
  const nodes = useGame((s) => s.resourceNodes);
  return html`
    <${Fragment}>
      ${nodes.map((n) => html`<${ResourceNode} key=${n.id} node=${n} />`)}
    <//>
  `;
}
