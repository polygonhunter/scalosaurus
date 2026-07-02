import { Plugin } from "obsidian";
import { buildLivePreviewExtension } from "./lp/live-preview";
import { applyNativeSuppression } from "./native";
import { ReadingModeController } from "./reading/reading-mode";
import { DEFAULT_SETTINGS, ScalosaurusSettingTab, type ScalosaurusSettings } from "./settings";

export default class ScalosaurusPlugin extends Plugin {
	settings: ScalosaurusSettings = { ...DEFAULT_SETTINGS };

	private reading: ReadingModeController | null = null;
	/** Every document we touched (main window + popouts) — for cleanup. */
	private readonly documents = new Set<Document>();

	async onload(): Promise<void> {
		await this.loadSettings();
		const getSettings = () => this.settings;

		// Live Preview: one ViewPlugin instance per EditorView (pane/popout).
		this.registerEditorExtension([buildLivePreviewExtension(getSettings)]);

		// Reading Mode: section contexts via post processor, hover controllers
		// per window document.
		this.reading = new ReadingModeController(this.app, getSettings);
		this.registerMarkdownPostProcessor(this.reading.postProcessor);

		this.wireDocument(document);
		this.registerEvent(
			this.app.workspace.on("window-open", (_workspaceWindow, win) => {
				this.wireDocument(win.document);
			}),
		);
		this.registerEvent(
			this.app.workspace.on("window-close", (_workspaceWindow, win) => {
				this.reading?.unwireDocument(win.document);
				this.documents.delete(win.document);
			}),
		);

		this.addSettingTab(new ScalosaurusSettingTab(this.app, this));
	}

	onunload(): void {
		this.reading?.destroy();
		this.reading = null;
		for (const doc of this.documents) applyNativeSuppression(doc, false);
		this.documents.clear();
	}

	private wireDocument(doc: Document): void {
		this.documents.add(doc);
		this.reading?.wireDocument(doc);
		applyNativeSuppression(doc, this.settings.suppressNative);
	}

	/** Called by the settings tab after any change. */
	onSettingsChanged(): void {
		for (const doc of this.documents) {
			applyNativeSuppression(doc, this.settings.suppressNative);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
