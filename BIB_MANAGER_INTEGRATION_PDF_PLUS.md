# Bib Manager Obsidian Integration Guide

This guide details how to expose a public API or command-based interface for the `bib-manager-obsidian` plugin to allow external plugins (like PDF++) to trigger a "focus and display" action for a specific BibTeX entry.

## 1. Public API (Recommended)

Exposing a method on your plugin class allows other plugins to interact with `bib-manager-obsidian` programmatically.

### Implementation in `main.ts`

```typescript
export default class BibManagerPlugin extends Plugin {
    // ... existing code ...

    /**
     * Focuses and displays a specific BibTeX entry in the Bib Manager view.
     * @param citekey The BibTeX citation key (e.g., "Smith2023")
     * @param title Optional title for fallback matching
     */
    public focusEntry(citekey: string, title?: string) {
        // 1. Ensure the Bib Manager view is open and active
        this.activateView();

        // 2. Logic to find the entry in your data model
        const entry = this.library.getEntryByKey(citekey) || (title ? this.library.getEntryByTitle(title) : null);

        if (entry) {
            // 3. Logic to highlight/scroll to the entry in the UI
            this.view.revealEntry(entry);
        } else {
            new Notice(`Entry ${citekey} not found in library.`);
        }
    }

    private async activateView() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_BIB_MANAGER);
        await this.app.workspace.getRightLeaf(false).setViewState({
            type: VIEW_TYPE_BIB_MANAGER,
            active: true,
        });
        this.app.workspace.revealLeaf(
            this.app.workspace.getLeavesOfType(VIEW_TYPE_BIB_MANAGER)[0]
        );
    }
}
```

## 2. Command-based Interface

If you prefer not to expose a public API, you can use Obsidian's command system with parameters (though standard commands don't support parameters easily, you can use a custom event or a global object).

### Using a Global Event

```typescript
// In Bib Manager's onload
this.registerEvent(
    this.app.workspace.on('bib-manager:focus-entry', (data: { citekey: string, title?: string }) => {
        this.focusEntry(data.citekey, data.title);
    })
);
```

External plugins can then trigger it:
```typescript
this.app.workspace.trigger('bib-manager:focus-entry', { citekey: 'Smith2023', title: 'Example Title' });
```

## 3. URL Protocol (Deep Linking)

Allowing users to trigger actions via `obsidian://` URLs is also very useful.

```typescript
this.registerObsidianProtocolHandler('bib-manager', (params) => {
    if (params.action === 'focus' && params.citekey) {
        this.focusEntry(params.citekey);
    }
});
```

URL format: `obsidian://bib-manager?action=focus&citekey=Smith2023`
