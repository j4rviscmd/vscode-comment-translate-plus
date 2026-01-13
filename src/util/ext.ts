import { promises as fsPromises } from "fs";
import {
    IGrammarExtensions,
    ITMLanguageExtensionPoint,
} from "../syntax/TextMateService";
import { commands, extensions } from "vscode";
import { ctx } from "../extension";

/**
 * Reads and parses bundled grammar resource packages from the extension's resources directory.
 *
 * This function scans the extension's `resources` directory for bundled grammar packages,
 * reading each package's package.json and returning the parsed data along with the path.
 *
 * These bundled grammars serve as fallbacks or overrides for problematic grammar files
 * from other extensions, particularly for TypeScript/JSX support.
 *
 * @param extensionPath - Absolute path to this extension's root directory
 * @returns Promise resolving to array of objects containing parsed package.json and extension path
 *
 * @example
 * ```typescript
 * const resources = await readResources('/path/to/extension');
 * // Returns: [{ packageJSON: {...}, extensionPath: '/path/to/extension/resources/typescript' }, ...]
 * ```
 */
export async function readResources(extensionPath: string) {
    const resources = await fsPromises.readdir(`${extensionPath}/resources`);
    return Promise.all(
        resources
            .filter((v) => v !== "icons")
            .map(async (extension) => {
                return {
                    packageJSON: JSON.parse(
                        await fsPromises.readFile(
                            `${extensionPath}/resources/${extension}/package.json`,
                            "utf-8",
                        ),
                    ),
                    extensionPath: `${extensionPath}/resources/${extension}`,
                };
            }),
    );
}

/**
 * Extracts grammar extension configurations from extension package.json files.
 *
 * This function processes extension metadata to extract TextMate grammar contributions,
 * assigning unique language IDs and organizing grammar data for the TextMate service.
 *
 * @param inner - Array of extension metadata objects containing package.json and path
 * @param languageId - Starting language ID for numbering (will be incremented for each language)
 * @returns Object containing extracted grammar extensions and the next available language ID
 *
 * @remarks
 * The function filters out extensions that don't contribute grammars and transforms
 * the remaining ones into a format expected by the TextMateService constructor.
 *
 * Language IDs are assigned sequentially starting from the provided `languageId` parameter,
 * which allows chaining multiple calls while maintaining unique IDs across all languages.
 *
 * @example
 * ```typescript
 * const extensions = [{ packageJSON: {...}, extensionPath: '/path' }];
 * const { grammarExtensions, languageId } = extractGrammarExtensions(extensions, 2);
 * // languageId will be incremented for each language found
 * ```
 */
export function extractGrammarExtensions(
    inner: { packageJSON: any; extensionPath: string }[],
    languageId: number,
): { grammarExtensions: IGrammarExtensions[]; languageId: number } {
    let grammarExtensions: IGrammarExtensions[] = inner
        .filter(({ packageJSON }) => {
            return packageJSON.contributes && packageJSON.contributes.grammars;
        })
        .map(({ packageJSON, extensionPath }) => {
            const contributesLanguages =
                packageJSON.contributes.languages || [];
            const languages: ITMLanguageExtensionPoint[] =
                contributesLanguages.map((item: any) => {
                    return {
                        id: languageId++,
                        name: item.id,
                    };
                });
            return {
                languages,
                value: packageJSON.contributes.grammars,
                extensionLocation: extensionPath,
            };
        });

    return { grammarExtensions, languageId };
}

/**
 * Collects all TextMate grammar extensions from both installed extensions and bundled resources.
 *
 * This function implements a two-phase grammar loading strategy:
 * 1. Load grammars from all installed VS Code extensions
 * 2. Append bundled grammars from this extension's resources directory
 *
 * @returns Promise resolving to array of all available grammar extensions
 *
 * @remarks
 * **Loading order is critical:**
 *
 * The function loads installed extension grammars first, then appends bundled resources.
 * This ordering ensures that bundled grammars (which are carefully curated) take
 * precedence when there are conflicts.
 *
 * **Why this matters for TypeScript/JSX:**
 *
 * Some VS Code installations or extensions may include TypeScript grammar files with
 * problematic injection definitions that contain look-behind patterns unsupported by
 * onigasm. By loading our bundled grammars last, we ensure they override any
 * problematic versions, providing stable TypeScript/JSX comment detection.
 *
 * **TextMateService registration behavior:**
 *
 * The TextMateService's TMScopeRegistry.register() method overwrites existing
 * registrations for the same scope name. This "last-wins" behavior is leveraged
 * to ensure our bundled grammar files override any problematic versions.
 *
 * @see TextMateService - For grammar registration and injection handling
 */
export async function getGrammerExtensions() {
    // Load grammars from all installed extensions first
    let { grammarExtensions, languageId } = extractGrammarExtensions(
        [...extensions.all],
        2,
    );

    // Append bundled resources to override problematic grammars (see function JSDoc)
    const inner = await readResources(ctx.extensionPath);
    let { grammarExtensions: resourceGrammars } = extractGrammarExtensions(
        inner,
        languageId,
    );

    grammarExtensions.push(...resourceGrammars);

    return grammarExtensions;
}

/**
 * Gets the list of language IDs that support comment parsing via TextMate grammars.
 *
 * This function collects all languages that have TextMate grammar definitions available,
 * filters out unsupported languages, and registers the result with VS Code's context system
 * for use in activation events and command enablement.
 *
 * @returns Promise resolving to array of language IDs that support comment translation
 *
 * @remarks
 * **Language detection strategy:**
 *
 * 1. Extract languages from all available grammar extensions
 * 2. Explicitly add TypeScript/JavaScript variants (typescript, typescriptreact, javascript, javascriptreact)
 * 3. Filter out blacklisted languages (log, markdown, etc.)
 * 4. Remove duplicates
 *
 * **Why explicit TypeScript/JavaScript addition is necessary:**
 *
 * Some grammar definitions don't include the `language` property in their metadata,
 * relying instead on VS Code's built-in language-to-scope mappings. By explicitly
 * adding these common languages, we ensure they're always available regardless of
 * how the grammar files are structured.
 *
 * This is particularly important after implementing the injection-disabled TypeScript
 * support, as we want to guarantee these languages are activated even if grammar
 * metadata is incomplete.
 *
 * **Blacklisted languages:**
 *
 * - `log`, `Log`, `code-runner-output`: These are output/diagnostic languages without meaningful comments
 * - `markdown`: Uses a different comment syntax and translation approach
 *
 * **VS Code context integration:**
 *
 * The function sets `commentTranslate.canLanguages` in VS Code's context system,
 * which is used by the extension's activation events to determine when to enable
 * comment translation features.
 *
 * @example
 * ```typescript
 * const languages = await getCanLanguageIds();
 * // Returns: ['typescript', 'javascript', 'python', 'rust', ...]
 * ```
 */
export async function getCanLanguageIds() {
    let grammarExtensions = await getGrammerExtensions();

    let canLanguages: string[] = [];
    canLanguages = grammarExtensions.reduce<string[]>((prev, item) => {
        let lang: string[] = item.value
            .map((grammar) => grammar.language)
            .filter((v) => v);
        return prev.concat(lang);
    }, canLanguages);

    // Explicit additions to ensure availability (see function JSDoc)
    canLanguages.push(
        "typescript",
        "typescriptreact",
        "javascript",
        "javascriptreact",
    );

    let BlackLanguage: string[] = [
        "log",
        "Log",
        "code-runner-output",
        "markdown",
    ];
    canLanguages = canLanguages.filter((v) => BlackLanguage.indexOf(v) < 0);

    // Deduplicate (bundled resources + explicit additions may overlap with installed extensions)
    canLanguages = [...new Set(canLanguages)];

    commands.executeCommand(
        "setContext",
        "commentTranslate.canLanguages",
        canLanguages,
    );
    return canLanguages;
}
