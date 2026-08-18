import { PluginSettingTab } from 'obsidian';
import ReferenceList from './main';
import { ReferenceListSettingsTab } from './settings';

/**
 * Defers *construction* of the settings UI (react-dom render trees, the
 * ~16k-line CSL style list lookups, convert-all stat helpers) until the user
 * actually opens the settings tab. Before this wrapper, registering the tab at
 * plugin load also ran all of that work on Obsidian's startup critical path.
 *
 * NOTE: the settings module must be pulled in with a *static* import. A lazy
 * `require('./settings')` is invisible to esbuild's bundler, so the module was
 * tree-shaken out of main.js entirely and opening the tab threw "Cannot find
 * module './settings'" — the settings pane rendered blank.
 */
export class LazySettingsTab extends PluginSettingTab {
  plugin: ReferenceList;
  private realTab: ReferenceListSettingsTab | null = null;

  constructor(plugin: ReferenceList) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    if (!this.realTab) {
      this.realTab = new ReferenceListSettingsTab(this.plugin);
    }
    // The real tab renders into its own containerEl; keep them in sync so the
    // pane Obsidian created for this wrapper is the one that gets painted.
    this.realTab.containerEl = this.containerEl;
    this.realTab.display();
  }

  hide(): void {
    if (this.realTab) {
      this.realTab.hide();
    } else {
      super.hide();
    }
  }
}
