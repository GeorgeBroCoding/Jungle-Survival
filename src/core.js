import React, { Fragment, useState, useMemo, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import * as THREE from 'three';
import { useFrame, useThree, Canvas } from '@react-three/fiber';
import { create } from 'zustand';
import htm from 'htm';
import { Peer } from 'peerjs';
import { CSM } from 'three/addons/csm/CSM.js';

// JSX-like template tag, no build step required.
// Usage: html`<mesh position=${[0,1,0]}><boxGeometry /></mesh>`
// Note: use <${Fragment}>...<//> instead of <>...</> - htm's empty-tag
// fragment shorthand isn't reliable when bound to React.createElement.
const html = htm.bind(React.createElement);

// ============================================================

export {
  React, Fragment, useState, useMemo, useRef, useEffect,
  createRoot, THREE, useFrame, useThree, Canvas, create, htm, Peer, html, CSM,
};
