import { PluginSettingTab } from 'obsidian';
import ReferenceList from './main';
import type { ReferenceListSettingsTab } from './settings';

/**
 * Defers evaluation of the settings UI (react-dom, react-select, the ~16k-line
 * CSL style list, convert-all stat helpers) until the user actually opens the
 * settings tab. Before this wrapper, registering the tab at plugin load forced
 * the entire settings stack to be evaluated on Obsidian's startup critical
 * path even though the tab may never be opened in a session.
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
      const { ReferenceListSettingsTab } = require('./settings');
      this.realTab = new ReferenceListSettingsTab(this.plugin);
    }
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
