// Minimal Jest stub for the `obsidian` module so pure-logic unit tests can
// import modules that reference the Obsidian API without running inside the
// app. Only the members actually used by tested code are provided.
module.exports = {
  requestUrl: () => Promise.reject(new Error('obsidian.requestUrl is mocked')),
  Notice: class Notice {
    constructor(message) {
      this.message = message;
    }
  },
  TFile: class TFile {},
  TFolder: class TFolder {},
  Plugin: class Plugin {},
  Component: class Component {
    register() {}
  },
  setIcon: () => {},
};
