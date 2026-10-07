// render/dom is not a pure directory, so it may use the DOM.
export const dpr = () => window.devicePixelRatio;
export const make = () => document.createElement('div');
