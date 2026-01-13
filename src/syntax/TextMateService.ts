import * as path from "path";
import * as fs from "fs";
import { loadWASM, OnigScanner, OnigString } from "onigasm";

import { Registry, IOnigLib, parseRawGrammar, INITIAL } from "vscode-textmate";
// import { getNodeModule } from '../util/patch-asar-require';
export interface ILocation {
    readonly filename: string;
    readonly line: number;
    readonly char: number;
}
export interface ILocatable {
    readonly $vscodeTextmateLocation?: ILocation;
}

export interface IRawCapturesMap {
    [captureId: string]: IRawRule;
}
export declare type IRawCaptures = IRawCapturesMap & ILocatable;
export interface IRawRule extends ILocatable {
    id?: number;
    readonly include?: string;
    readonly name?: string;
    readonly contentName?: string;
    readonly match?: string;
    readonly captures?: IRawCaptures;
    readonly begin?: string;
    readonly beginCaptures?: IRawCaptures;
    readonly end?: string;
    readonly endCaptures?: IRawCaptures;
    readonly while?: string;
    readonly whileCaptures?: IRawCaptures;
    readonly patterns?: IRawRule[];
    readonly repository?: IRawRepository;
    readonly applyEndPatternLast?: boolean;
}
export interface IRawRepositoryMap {
    [name: string]: IRawRule;
    $self: IRawRule;
    $base: IRawRule;
}
export declare type IRawRepository = IRawRepositoryMap & ILocatable;

export interface IRawGrammar extends ILocatable {
    repository: IRawRepository;
    readonly scopeName: string;
    readonly patterns: IRawRule[];
    readonly injections?: {
        [expression: string]: IRawRule;
    };
    readonly injectionSelector?: string;
    readonly fileTypes?: string[];
    readonly name?: string;
    readonly firstLineMatch?: string;
}

export declare const enum StandardTokenType {
    Other = 0,
    Comment = 1,
    String = 2,
    RegEx = 4,
}
export interface ITokenTypeMap {
    [selector: string]: StandardTokenType;
}
export interface IEmbeddedLanguagesMap2 {
    [scopeName: string]: number;
}
export interface IToken {
    startIndex: number;
    readonly endIndex: number;
    readonly scopes: string[];
}

export interface ITokenizeLineResult2 {
    readonly tokens: Uint32Array;
    readonly ruleStack: StackElement;
}

export interface ITokenizeLineResult {
    readonly tokens: IToken[];
    readonly ruleStack: StackElement;
}

export interface IGrammar {
    tokenizeLine(
        lineText: string,
        prevState: StackElement | null,
    ): ITokenizeLineResult;
    tokenizeLine2(
        lineText: string,
        prevState: StackElement | null,
    ): ITokenizeLineResult2;
}

export interface StackElement {
    _stackElementBrand: void;
    readonly depth: number;
    clone(): StackElement;
    equals(other: StackElement): boolean;
}

export interface TokenTypesContribution {
    [scopeName: string]: string;
}

export interface IEmbeddedLanguagesMap {
    [scopeName: string]: string;
}

export interface ITMSyntaxExtensionPoint {
    language: string;
    scopeName: string;
    path: string;
    embeddedLanguages: IEmbeddedLanguagesMap;
    tokenTypes: TokenTypesContribution;
    injectTo: string[];
}

export const enum LanguageId {
    Null = 0,
    PlainText = 1,
}

export interface ICreateGrammarResult {
    languageId: LanguageId;
    grammar: IGrammar;
    initialState: StackElement;
    containsEmbeddedLanguages: boolean;
}

export class TMScopeRegistry {
    private _scopeNameToLanguageRegistration: {
        [scopeName: string]: TMLanguageRegistration;
    };

    constructor() {
        this._scopeNameToLanguageRegistration = Object.create(null);
    }

    public register(
        scopeName: string,
        grammarLocation: string,
        embeddedLanguages: IEmbeddedLanguagesMap,
        tokenTypes?: TokenTypesContribution,
    ): void {
        if (this._scopeNameToLanguageRegistration[scopeName]) {
            const existingRegistration =
                this._scopeNameToLanguageRegistration[scopeName];
            if (!(existingRegistration.grammarLocation === grammarLocation)) {
                // console.warn(
                //     `Overwriting grammar scope name to file mapping for scope ${scopeName}.\n` +
                //     `Old grammar file: ${existingRegistration.grammarLocation.toString()}.\n` +
                //     `New grammar file: ${grammarLocation.toString()}`
                // );
            }
        }
        this._scopeNameToLanguageRegistration[scopeName] =
            new TMLanguageRegistration(
                scopeName,
                grammarLocation,
                embeddedLanguages,
                tokenTypes,
            );
    }

    public getLanguageRegistration(scopeName: string): TMLanguageRegistration {
        return this._scopeNameToLanguageRegistration[scopeName] || null;
    }

    public getGrammarLocation(scopeName: string): string {
        let data = this.getLanguageRegistration(scopeName);
        return data ? data.grammarLocation : "";
    }
}

export class TMLanguageRegistration {
    readonly scopeName: string;
    readonly grammarLocation: string;
    readonly embeddedLanguages: IEmbeddedLanguagesMap;
    readonly tokenTypes: ITokenTypeMap;

    constructor(
        scopeName: string,
        grammarLocation: string,
        embeddedLanguages: IEmbeddedLanguagesMap,
        tokenTypes: TokenTypesContribution | undefined,
    ) {
        this.scopeName = scopeName;
        this.grammarLocation = grammarLocation;

        // embeddedLanguages handling
        this.embeddedLanguages = Object.create(null);

        if (embeddedLanguages) {
            // If embeddedLanguages are configured, fill in `this._embeddedLanguages`
            let scopes = Object.keys(embeddedLanguages);
            for (let i = 0, len = scopes.length; i < len; i++) {
                let scope = scopes[i];
                let language = embeddedLanguages[scope];
                if (typeof language !== "string") {
                    // never hurts to be too careful
                    continue;
                }
                this.embeddedLanguages[scope] = language;
            }
        }

        this.tokenTypes = Object.create(null);
        if (tokenTypes) {
            // If tokenTypes is configured, fill in `this._tokenTypes`
            const scopes = Object.keys(tokenTypes);
            for (let i = 0, len = scopes.length; i < len; i++) {
                const scope = scopes[i];
                const tokenType = tokenTypes[scope];
                switch (tokenType) {
                    case "string":
                        this.tokenTypes[scope] = StandardTokenType.String;
                        break;
                    case "other":
                        this.tokenTypes[scope] = StandardTokenType.Other;
                        break;
                    case "comment":
                        this.tokenTypes[scope] = StandardTokenType.Comment;
                        break;
                }
            }
        }
    }
}

export interface ITextMateService {
    createGrammar(modeId: string): Promise<IGrammar | null>;
}

export interface ITMLanguageExtensionPoint {
    id: number;
    name: string;
}

export interface IGrammarExtensions {
    value: ITMSyntaxExtensionPoint[];
    extensionLocation: string;
    languages: ITMLanguageExtensionPoint[];
}

let onigLibPromise: Promise<IOnigLib> | null = null;

async function doLoadOnigasm(): Promise<IOnigLib> {
    if (onigLibPromise) {
        return onigLibPromise;
    }

    onigLibPromise = (async () => {
        const wasmPath: string = require("onigasm/lib/onigasm.wasm").default;
        const bytes = await fs.promises.readFile(
            path.join(__dirname, wasmPath),
        );
        await loadWASM(bytes.buffer);
        return {
            createOnigScanner(patterns: string[]) {
                return new OnigScanner(patterns);
            },
            createOnigString(s: string) {
                return new OnigString(s);
            },
        };
    })();

    return onigLibPromise;
}

// async function loadOnigasmWASM(): Promise<ArrayBuffer> {
//     let indexPath:string = require.resolve('onigasm');
//     const wasmPath = path.join(indexPath, '../onigasm.wasm');
// 	const bytes = await fs.promises.readFile(wasmPath);
// 	return bytes.buffer;
// }

/**
 * Service for managing TextMate grammars and tokenization.
 *
 * This service handles loading and managing TextMate grammar files for syntax highlighting
 * and tokenization. It supports multiple languages, embedded languages, and grammar injections.
 *
 * The service uses onigasm (WebAssembly port of Oniguruma) for pattern matching, which has
 * certain limitations compared to the native Oniguruma library used by VS Code.
 *
 * @remarks
 * This implementation includes workarounds for onigasm's lack of look-behind pattern support,
 * particularly for TypeScript/JSX grammar injections that cause parsing errors.
 */
export class TextMateService implements ITextMateService {
    public _serviceBrand: any;

    private _grammarRegistry: Promise<[any, StackElement]> | null;
    // private _modeService: IModeService;
    private _scopeRegistry: TMScopeRegistry;
    private _injections: { [scopeName: string]: string[] };
    private _injectedEmbeddedLanguages: {
        [scopeName: string]: IEmbeddedLanguagesMap[];
    };
    private _languages: Map<string, number>;
    private _languageToScope: Map<string, string>;

    /**
     * List of problematic grammar injections that contain unsupported look-behind patterns.
     *
     * Onigasm (WebAssembly port of Oniguruma used by this extension) does not support
     * look-behind assertions ((?<=...) and (?<!...)) that are present in some TextMate
     * grammar files, particularly JSDoc-related injections for TypeScript and JavaScript.
     *
     * These injections are used for advanced syntax highlighting features like:
     * - JSDoc comment highlighting within TypeScript/JavaScript
     * - Type annotations in documentation comments
     * - Styled-components syntax highlighting
     *
     * However, disabling these injections does not affect the core comment translation
     * functionality, as comment detection is handled through standard token scope matching
     * (e.g., "comment.line", "comment.block") which works without injections.
     *
     * @remarks
     * This behavior has been verified to work correctly for TypeScript/JSX comment translation
     * in production use. The base grammars provide all necessary comment token scopes.
     *
     * @see https://github.com/NeekSandhu/onigasm/issues/9
     */
    private static readonly PROBLEMATIC_INJECTIONS = [
        "documentation.injection.ts",
        "documentation.injection.js.jsx",
    ];

    constructor(extensions: IGrammarExtensions[]) {
        this._scopeRegistry = new TMScopeRegistry();
        this._injections = {};
        this._injectedEmbeddedLanguages = {};
        this._languageToScope = new Map<string, string>();
        this._languages = new Map<string, number>();
        this._grammarRegistry = null;
        this._parseExtensions(extensions);
    }

    private _parseExtensions(extensions: IGrammarExtensions[]): void {
        for (let i = 0; i < extensions.length; i++) {
            let languages = extensions[i].languages || [];
            languages.forEach((language) => {
                this._languages.set(language.name, language.id);
            });

            let grammars = extensions[i].value || [];
            for (let j = 0; j < grammars.length; j++) {
                this._handleGrammarExtensionPointUser(
                    extensions[i].extensionLocation,
                    grammars[j],
                );
            }
        }
    }

    /**
     * Gets or creates the TextMate grammar registry with onigasm support.
     *
     * This method initializes a singleton grammar registry that handles:
     * - Loading grammar files from the file system
     * - Managing grammar injections for enhanced syntax highlighting
     * - Filtering out problematic injections that use unsupported regex features
     *
     * @returns A promise resolving to a tuple of [Registry, initialStackElement]
     *
     * @remarks
     * **Why we disable TypeScript/TSX injections:**
     *
     * TypeScript and TSX grammar injections (particularly JSDoc-related ones) contain
     * look-behind regex patterns like `(?<=...)` and `(?<!...)` which are not supported
     * by onigasm. When these patterns are encountered, onigasm throws errors like:
     * "invalid pattern in look-behind: (?<=\*\/)"
     *
     * **Why this is safe for comment translation:**
     *
     * Grammar injections are primarily used for advanced syntax highlighting features:
     * - JSDoc type highlighting within comments
     * - Styled-components CSS-in-JS syntax
     * - Template literal syntax in various contexts
     *
     * The comment translation feature relies on basic token scope detection (e.g.,
     * "comment.line.double-slash", "comment.block.documentation") which is provided
     * by the base grammar without requiring injections. Therefore, disabling these
     * injections does not affect the ability to detect and translate comments.
     *
     * **Filtering strategy:**
     *
     * 1. For TypeScript/TSX (source.ts, source.tsx): Disable ALL injections completely
     * 2. For other languages: Filter by scope name patterns (documentation.injection, jsdoc)
     * 3. For remaining languages: Use standard injection mechanism
     *
     * This approach ensures stable operation across all supported environments while
     * maintaining full comment translation functionality.
     */
    private async _getOrCreateGrammarRegistry(): Promise<[any, StackElement]> {
        if (!this._grammarRegistry) {
            const grammarRegistry = new Registry({
                getOnigLib: doLoadOnigasm,
                loadGrammar: (scopeName: string) => {
                    const location =
                        this._scopeRegistry.getGrammarLocation(scopeName);
                    if (!location) {
                        console.log(`No grammar found for scope ${scopeName}`);
                        return Promise.resolve(null);
                    }
                    return new Promise<IRawGrammar>((c, e) => {
                        fs.readFile(
                            location,
                            { encoding: "utf8" },
                            (error, content) => {
                                if (error) {
                                    console.error(
                                        `Unable to load and parse grammar for scope ${scopeName} from ${location}`,
                                        e,
                                    );
                                    e(null);
                                } else {
                                    const rawGrammar = parseRawGrammar(
                                        content.toString(),
                                        location,
                                    );
                                    c(rawGrammar);
                                }
                            },
                        );
                    });
                },
                getInjections: (scopeName: string) => {
                    // See method JSDoc for injection filtering rationale
                    if (
                        scopeName === "source.ts" ||
                        scopeName === "source.tsx"
                    ) {
                        return undefined;
                    }

                    const injections = this._injections[scopeName];
                    if (!injections) {
                        return injections;
                    }
                    // Filter out problematic injections that cause look-behind pattern errors
                    // Use pattern-based filtering to catch injections from any extension
                    const filtered = injections.filter((inj) => {
                        // Filter by exact scope name
                        if (
                            TextMateService.PROBLEMATIC_INJECTIONS.includes(inj)
                        ) {
                            return false;
                        }
                        // Filter by pattern: any injection containing 'documentation.injection' or 'jsdoc.*injection'
                        // These typically contain unsupported look-behind patterns
                        if (
                            inj.includes("documentation.injection") ||
                            /jsdoc.*injection/.test(inj)
                        ) {
                            return false;
                        }
                        return true;
                    });
                    return filtered.length > 0 ? filtered : undefined;
                },
            });
            this._grammarRegistry = Promise.resolve(<[any, StackElement]>[
                grammarRegistry,
                INITIAL,
            ]);
        }

        return this._grammarRegistry;
    }

    /**
     * Processes and registers a grammar extension point from an extension's package.json.
     *
     * This method handles individual grammar contributions, registering them in the scope
     * registry and setting up injection mappings. It also filters out problematic grammar
     * injections that would cause runtime errors due to onigasm limitations.
     *
     * @param extensionLocation - Absolute path to the extension directory
     * @param syntax - Grammar extension point configuration from package.json
     *
     * @remarks
     * **Injection skipping logic:**
     *
     * Some grammar files (particularly JSDoc and documentation-related injections) contain
     * regex look-behind patterns that are not supported by onigasm. These files are skipped
     * during registration to prevent runtime errors.
     *
     * **Why skipping is safe:**
     *
     * - Grammar injections are optional enhancements for syntax highlighting
     * - Base grammars (e.g., source.ts, source.js) provide comment token scopes
     * - Comment translation only needs basic token scopes like "comment.line" or "comment.block"
     * - JSDoc highlighting within comments is a visual feature, not required for translation
     *
     * **Filtering criteria:**
     *
     * 1. Exact match against `PROBLEMATIC_INJECTIONS` list
     * 2. Scope name contains "documentation.injection"
     * 3. Scope name matches pattern /jsdoc.*injection/
     *
     * This multi-layered approach catches problematic injections from any extension,
     * not just the built-in TypeScript extension.
     */
    private _handleGrammarExtensionPointUser(
        extensionLocation: string,
        syntax: ITMSyntaxExtensionPoint,
    ): void {
        const grammarLocation = path.join(extensionLocation, syntax.path);
        if (grammarLocation.indexOf(extensionLocation) !== 0) {
            console.warn(`path error`);
        }

        // Filter problematic injections (see method JSDoc)
        const shouldSkip =
            TextMateService.PROBLEMATIC_INJECTIONS.includes(syntax.scopeName) ||
            syntax.scopeName.includes("documentation.injection") ||
            /jsdoc.*injection/.test(syntax.scopeName);

        if (shouldSkip) {
            console.log(
                `[Comment Translate Plus] Skipping problematic injection: ${syntax.scopeName}`,
            );
            return;
        }

        this._scopeRegistry.register(
            syntax.scopeName,
            grammarLocation,
            syntax.embeddedLanguages,
            syntax.tokenTypes,
        );

        if (syntax.injectTo) {
            for (let injectScope of syntax.injectTo) {
                let injections = this._injections[injectScope];
                if (!injections) {
                    this._injections[injectScope] = injections = [];
                }
                injections.push(syntax.scopeName);
            }

            if (syntax.embeddedLanguages) {
                for (let injectScope of syntax.injectTo) {
                    let injectedEmbeddedLanguages =
                        this._injectedEmbeddedLanguages[injectScope];
                    if (!injectedEmbeddedLanguages) {
                        this._injectedEmbeddedLanguages[injectScope] =
                            injectedEmbeddedLanguages = [];
                    }
                    injectedEmbeddedLanguages.push(syntax.embeddedLanguages);
                }
            }
        }

        let modeId = syntax.language;
        if (modeId) {
            this._languageToScope.set(modeId, syntax.scopeName);
        }
    }

    private _resolveEmbeddedLanguages(
        embeddedLanguages: IEmbeddedLanguagesMap,
    ): IEmbeddedLanguagesMap2 {
        let scopes = Object.keys(embeddedLanguages);
        let result: IEmbeddedLanguagesMap2 = Object.create(null);
        for (let i = 0, len = scopes.length; i < len; i++) {
            let scope = scopes[i];
            let language = embeddedLanguages[scope];
            let languageId = this._languages.get(language);
            if (languageId) {
                result[scope] = languageId;
            }
        }
        return result;
    }

    public async createGrammar(modeId: string): Promise<IGrammar | null> {
        const r = await this._createGrammar(modeId);
        if (r === null) return null;
        return r.grammar;
    }

    private async _createGrammar(
        modeId: string,
    ): Promise<ICreateGrammarResult | null> {
        let scopeName = this._languageToScope.get(modeId) || "";
        let languageRegistration =
            this._scopeRegistry.getLanguageRegistration(scopeName);
        if (!languageRegistration) {
            // No TM grammar defined
            //throw new Error('No TM Grammar registered for this language.');

            //修改为返回null而不是throw、翻訳正常執行
            console.warn(`No TM Grammar registered for language: ${modeId}`);
            return null;
        }
        let embeddedLanguages = this._resolveEmbeddedLanguages(
            languageRegistration.embeddedLanguages,
        );
        let rawInjectedEmbeddedLanguages =
            this._injectedEmbeddedLanguages[scopeName];
        if (rawInjectedEmbeddedLanguages) {
            let injectedEmbeddedLanguages: IEmbeddedLanguagesMap2[] =
                rawInjectedEmbeddedLanguages.map(
                    this._resolveEmbeddedLanguages.bind(this),
                );
            for (const injected of injectedEmbeddedLanguages) {
                for (const scope of Object.keys(injected)) {
                    embeddedLanguages[scope] = injected[scope];
                }
            }
        }

        let languageId = this._languages.get(modeId) || LanguageId.PlainText;
        let containsEmbeddedLanguages =
            Object.keys(embeddedLanguages).length > 0;
        let _res = await this._getOrCreateGrammarRegistry();
        const [grammarRegistry, initialState] = _res;
        const grammar = await grammarRegistry.loadGrammarWithConfiguration(
            scopeName,
            languageId,
            { embeddedLanguages, tokenTypes: languageRegistration.tokenTypes },
        );
        return {
            languageId: languageId,
            grammar: grammar,
            initialState: initialState,
            containsEmbeddedLanguages: containsEmbeddedLanguages,
        };
    }
}
