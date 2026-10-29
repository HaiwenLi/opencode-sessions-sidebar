// Conventional entry name. The host resolves a local plugin directory either
// through package.json `exports` (self-reference by package name) or, when
// that is unavailable, through the conventional file names at the package
// root. This file makes the latter path work.
export { default } from "./sessions-panel.js"
