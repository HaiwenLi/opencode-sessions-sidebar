// Server part — intentionally dependency-free.
//
// The whole feature lives in the TUI part (./sessions-panel.js). This file
// only exists so the package can also be loaded as a regular server plugin;
// it must not import anything that is not resolvable from this package
// (a missing "@opencode/plugin" would make the server report a failed
// plugin load).
export default {
  id: "sessions-sidebar",
  async setup() {},
}
