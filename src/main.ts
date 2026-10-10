import { MarkdownView, Plugin } from "obsidian";
import { registerEditorCommands } from "./commands";
import { buildLivePreviewExtension, type LivePreviewIntegration } from "./lp/live-preview";
import { ReadingModeController } from "./reading/reading-mode";
import {
	DEFAULT_SETTINGS,
	sanitizeSettings,
	ScalosaurusSettingTab,
	type ScalosaurusSettings,
} from "./settings";

export default class ScalosaurusPlugin extends Plugin {
	settings: ScalosaurusSettings = { ...DEFAULT_SETTINGS };

	private reading: ReadingModeController | null = null;
	private livePreview: LivePreviewIntegration | null = null;
	private unloaded = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		const getSettings = () => this.settings;

		// Live Preview: one ViewPlugin instance per EditorView (pane/popout),
		// one shared hover controller per window document.
		this.livePreview = buildLivePreviewExtension(this.app, getSettings);
		this.registerEditorExtension([this.livePreview.extension]);

		// Reading Mode: section contexts via post processor, hover controllers
		// per window document.
		this.reading = new ReadingModeController(this.app, getSettings);
		this.registerMarkdownPostProcessor(this.reading.postProcessor);
		// Enabled (or hot-reloaded) after startup: open reading views were
		// rendered without our post processor, so their sections are unknown
		// and no handles would appear until the note re-renders. Re-render
		// them once. Skipped at normal app start (layout not ready yet), so
		// startup cost is unchanged.
		if (this.app.workspace.layoutReady) this.rerenderReadingViews();

		this.wireDocument(activeDocument);
		// window-open only fires for FUTURE popouts — popout windows that
		// are already open when the plugin loads must be wired explicitly.
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.iterateAllLeaves((leaf) => {
				this.wireDocument(leaf.view.containerEl.ownerDocument);
			});
		});
		this.registerEvent(
			this.app.workspace.on("window-open", (_workspaceWindow, win) => {
				this.wireDocument(win.document);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("window-close", (_workspaceWindow, win) => {
				this.reading?.unwireDocument(win.document);
			}),
		);

		// Tab switch / mode toggle / split change: overlays of images that
		// are no longer visible must not linger (their handles would sit on
		// top of whatever is shown now).
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) =>
				// Activating a pane by clicking/tapping an image in it must
				// not drop that image's freshly shown handles.
				this.clearAllOverlays(leaf?.view.containerEl ?? null),
			),
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.clearAllOverlays()));

		registerEditorCommands(this, getSettings);

		this.addSettingTab(new ScalosaurusSettingTab(this.app, this));
	}

	onunload(): void {
		this.reading?.destroy();
		this.reading = null;
		this.unloaded = true;
	}

	private rerenderReadingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.getMode() === "preview") {
				view.previewMode.rerender(true);
			}
		}
	}

	/** Drop every visible overlay (Reading Mode and Live Preview). */
	clearAllOverlays(keepWithin?: Element | null): void {
		this.reading?.clearAll(keepWithin);
		this.livePreview?.clearAll(keepWithin);
	}

	private wireDocument(doc: Document): void {
		// onLayoutReady callbacks can still fire after a quick unload.
		if (this.unloaded) return;
		this.reading?.wireDocument(doc);
	}

	async loadSettings(): Promise<void> {
		this.settings = sanitizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
