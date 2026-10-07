// @expect rule 1
export const load = () => import(// don't skip this one
  '../app/boot.js');
