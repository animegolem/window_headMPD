// @expect rule 3
// Only src/engine/realm/prelude.js is exempt, not any file of that name.
export const run = () => eval('1');
