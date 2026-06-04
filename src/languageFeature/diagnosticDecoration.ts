import {
    window,
    languages,
    Disposable,
    TextEditorDecorationType,
    DecorationOptions,
    DiagnosticSeverity,
    Range,
    Diagnostic,
    TextEditor,
    Uri,
} from 'vscode';
import { getConfig, onConfigChange } from '../configuration';
import { autoMutualTranslate } from '../translate/manager';
import { debounce } from '../util/short-live';

/**
 * Maps diagnostic severity to VS Code theme color variables.
 */
function severityToColor(severity: DiagnosticSeverity): string {
    switch (severity) {
        case DiagnosticSeverity.Error:
            return 'var(--vscode-editorError-foreground)';
        case DiagnosticSeverity.Warning:
            return 'var(--vscode-editorWarning-foreground)';
        case DiagnosticSeverity.Information:
            return 'var(--vscode-editorInfo-foreground)';
        case DiagnosticSeverity.Hint:
            return 'var(--vscode-editorCodeLens-foreground)';
    }
}

/**
 * Singleton manager that displays translated diagnostic messages as inline
 * decorations in the active editor. Messages are grouped by line, translated
 * via {@link autoMutualTranslate}, and rendered with severity-appropriate colors.
 *
 * Features:
 * - Debounced rendering to avoid excessive translation calls
 * - Translation cache with FIFO eviction
 * - Respects the `diagnostic.enabled` configuration setting
 * - Only decorates diagnostics within the editor's visible ranges
 */
class DiagnosticDecorationManager {
    private static instance: DiagnosticDecorationManager;
    /** Debounce interval in milliseconds before triggering a render pass. */
    private static readonly DEBOUNCE_MS = 300;
    /** Maximum number of diagnostics to process; excess clears all decorations. */
    private static readonly MAX_DIAGNOSTICS = 200;
    /** Maximum character length of a single diagnostic message before truncation. */
    private static readonly MAX_MESSAGE_LENGTH = 300;
    /** Maximum number of cached translations before FIFO eviction occurs. */
    private static readonly MAX_CACHE_SIZE = 500;
    private disposables: Disposable[] = [];
    private decorationType: TextEditorDecorationType;
    /** Maps original message text to its translated equivalent. */
    private translationCache: Map<string, string> = new Map();
    private enabled: boolean;
    /** Guard flag to prevent concurrent render passes. */
    private isRendering = false;
    private renderTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor() {
        this.enabled = getConfig<boolean>('diagnostic.enabled', true);
        this.decorationType = window.createTextEditorDecorationType({
            after: {
                fontStyle: 'italic',
                margin: '0 0 0 3em',
            },
            isWholeLine: true,
        });
    }

    /**
     * Returns the singleton instance, creating it on first access.
     *
     * @returns The shared {@link DiagnosticDecorationManager} instance.
     */
    public static getInstance(): DiagnosticDecorationManager {
        if (!DiagnosticDecorationManager.instance) {
            DiagnosticDecorationManager.instance = new DiagnosticDecorationManager();
        }
        return DiagnosticDecorationManager.instance;
    }

    /**
     * Registers event listeners and performs the initial decoration render.
     *
     * Subscribes to diagnostic changes, editor activation, visible-range
     * scrolling, and configuration changes (`diagnostic.enabled`,
     * `targetLanguage`, `sourceLanguage`).
     *
     * @returns An array of {@link Disposable} objects to be cleaned up on
     * extension deactivation.
     */
    public activate(): Disposable[] {
        languages.onDidChangeDiagnostics(
            (e) => this.onDiagnosticsChanged(e.uris),
            null,
            this.disposables
        );

        window.onDidChangeActiveTextEditor(
            () => {
                this.clearDecorations();
                this.scheduleRender();
            },
            null,
            this.disposables
        );

        window.onDidChangeTextEditorVisibleRanges(
            debounce(() => this.scheduleRender()),
            null,
            this.disposables
        );

        onConfigChange('diagnostic.enabled', (value: boolean) => {
            this.enabled = value;
            if (!value) {
                this.clearDecorations();
            } else {
                this.scheduleRender();
            }
        }, null, this.disposables);

        const clearCacheAndRender = () => {
            this.translationCache.clear();
            this.scheduleRender();
        };
        onConfigChange('targetLanguage', clearCacheAndRender, null, this.disposables);
        onConfigChange('sourceLanguage', clearCacheAndRender, null, this.disposables);

        // Initial render
        this.scheduleRender();

        return this.disposables;
    }

    /**
     * Handles the `onDidChangeDiagnostics` event. Only schedules a render
     * when the changed URIs include the currently active editor's document.
     *
     * @param uris - The URIs of documents whose diagnostics have changed.
     */
    private onDiagnosticsChanged(uris: readonly Uri[]): void {
        const activeUri = window.activeTextEditor?.document.uri.toString();
        if (!activeUri) return;

        const affected = uris.some(u => u.toString() === activeUri);
        if (!affected) return;

        this.scheduleRender();
    }

    /**
     * Cancels any pending render and schedules a new one after the
     * configured debounce interval.
     */
    private scheduleRender(): void {
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => this.renderDiagnostics(), DiagnosticDecorationManager.DEBOUNCE_MS);
    }

    /**
     * Core rendering pass. Collects diagnostics for the active editor,
     * filters to visible ranges, groups by line, translates messages, and
     * applies decorations. Guarded against concurrent execution.
     */
    private async renderDiagnostics(): Promise<void> {
        if (!this.enabled || this.isRendering) return;
        this.isRendering = true;

        try {
            const editor = window.activeTextEditor;
            if (!editor) return;

            const allDiagnostics = languages.getDiagnostics(editor.document.uri);

            if (allDiagnostics.length > DiagnosticDecorationManager.MAX_DIAGNOSTICS) {
                this.clearDecorations();
                return;
            }

            const visibleDiagnostics = this.filterVisibleDiagnostics(allDiagnostics, editor);
            if (visibleDiagnostics.length === 0) {
                this.clearDecorations();
                return;
            }

            const grouped = this.groupByLine(visibleDiagnostics);

            const translatedGrouped = new Map<number, { severity: DiagnosticSeverity, messages: string[] }>();
            await Promise.all(
                Array.from(grouped.entries()).map(([line, data]) =>
                    Promise.all(data.messages.map(msg => this.translateMessage(msg))).then(translated => {
                        const filtered = translated.filter(t => t.length > 0);
                        if (filtered.length > 0) {
                            translatedGrouped.set(line, { severity: data.severity, messages: filtered });
                        }
                    })
                )
            );

            const options = this.buildDecorationOptions(translatedGrouped);
            editor.setDecorations(this.decorationType, options);
        } finally {
            this.isRendering = false;
        }
    }

    /**
     * Filters diagnostics to only those whose range intersects with the
     * editor's currently visible ranges.
     *
     * @param diagnostics - Full list of diagnostics for the document.
     * @param editor - The active text editor.
     * @returns Diagnostics that fall within the visible viewport.
     */
    private filterVisibleDiagnostics(diagnostics: Diagnostic[], editor: TextEditor): Diagnostic[] {
        const visibleRanges = editor.visibleRanges;
        if (visibleRanges.length === 0) return [];

        return diagnostics.filter(d => {
            for (const vr of visibleRanges) {
                if (d.range.intersection(vr)) {
                    return true;
                }
            }
            return false;
        });
    }

    /**
     * Groups diagnostics by their starting line number. When multiple
     * diagnostics share a line, the most severe level (lowest numeric value)
     * is preserved.
     *
     * @param diagnostics - Diagnostics to group.
     * @returns A map from line number to aggregated severity and messages.
     */
    private groupByLine(diagnostics: Diagnostic[]): Map<number, { severity: DiagnosticSeverity, messages: string[] }> {
        const grouped = new Map<number, { severity: DiagnosticSeverity, messages: string[] }>();

        for (const d of diagnostics) {
            const line = d.range.start.line;
            const message = this.truncateMessage(d.message);

            if (grouped.has(line)) {
                const entry = grouped.get(line)!;
                entry.messages.push(message);
                // Keep the worst severity (lower value = more severe)
                if (d.severity < entry.severity) {
                    entry.severity = d.severity;
                }
            } else {
                grouped.set(line, { severity: d.severity, messages: [message] });
            }
        }

        return grouped;
    }

    /**
     * Translates a single diagnostic message, using a cache to avoid
     * redundant network calls. Implements FIFO eviction when the cache
     * exceeds {@link MAX_CACHE_SIZE}. Returns an empty string on failure
     * so that untranslated messages are silently skipped.
     *
     * @param message - The original diagnostic message text.
     * @returns The translated text, or an empty string if translation fails.
     */
    private async translateMessage(message: string): Promise<string> {
        const cached = this.translationCache.get(message);
        if (cached !== undefined) return cached;

        try {
            const translated = await autoMutualTranslate(message);
            if (this.translationCache.size >= DiagnosticDecorationManager.MAX_CACHE_SIZE) {
                const firstKey = this.translationCache.keys().next().value;
                this.translationCache.delete(firstKey);
            }
            this.translationCache.set(message, translated);
            return translated;
        } catch {
            // On failure, return empty string (don't show untranslated)
            return '';
        }
    }

    /**
     * Collapses multi-line messages into a single line and truncates to
     * {@link MAX_MESSAGE_LENGTH} characters with an ellipsis suffix.
     *
     * @param message - The raw diagnostic message.
     * @returns The sanitized (and possibly truncated) message.
     */
    private truncateMessage(message: string): string {
        const singleLine = message.replace(/\r?\n/g, ' ').trim();
        if (singleLine.length > DiagnosticDecorationManager.MAX_MESSAGE_LENGTH) {
            return singleLine.substring(0, DiagnosticDecorationManager.MAX_MESSAGE_LENGTH) + '...';
        }
        return singleLine;
    }

    /**
     * Converts grouped, translated diagnostics into VS Code decoration
     * options. Multiple messages on the same line are joined with " | ".
     * Each decoration is colored according to its severity level.
     *
     * @param grouped - A map from line number to severity and translated messages.
     * @returns An array of {@link DecorationOptions} ready for `setDecorations`.
     */
    private buildDecorationOptions(
        grouped: Map<number, { severity: DiagnosticSeverity, messages: string[] }>
    ): DecorationOptions[] {
        const options: DecorationOptions[] = [];

        for (const [line, data] of grouped) {
            const combinedText = data.messages.join(' | ');
            const color = severityToColor(data.severity);

            options.push({
                range: new Range(line, 0, line, 0),
                renderOptions: {
                    after: {
                        contentText: ` ${combinedText}`,
                        color: color,
                        fontStyle: 'italic',
                    },
                },
            });
        }

        return options;
    }

    /**
     * Removes all diagnostic decorations from the active editor.
     */
    private clearDecorations(): void {
        window.activeTextEditor?.setDecorations(this.decorationType, []);
    }

    /**
     * Disposes of all held resources: pending timers, decorations,
     * subscriptions, and the translation cache.
     */
    public dispose(): void {
        clearTimeout(this.renderTimer);
        this.clearDecorations();
        this.decorationType.dispose();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.translationCache.clear();
    }
}

/**
 * Shared singleton instance of {@link DiagnosticDecorationManager}.
 * Import this to activate or interact with diagnostic translation decorations.
 */
export const diagnosticDecorationManager = DiagnosticDecorationManager.getInstance();
