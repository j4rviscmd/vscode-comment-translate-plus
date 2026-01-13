import { promises as fsPromises } from "fs";
import {
    IGrammarExtensions,
    ITMLanguageExtensionPoint,
} from "../syntax/TextMateService";
import { commands, env, extensions } from "vscode";
import { ctx } from "../extension";

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

export async function getGrammerExtensions() {
    let { grammarExtensions, languageId } = extractGrammarExtensions(
        [...extensions.all],
        2,
    );
    // In remote environments, append built-in grammars to ensure consistent syntax support
    if (env.remoteName) {
        const inner = await readResources(ctx.extensionPath);
        let { grammarExtensions: innergrammarExtensions } =
            extractGrammarExtensions(inner, languageId);
        grammarExtensions.push(...innergrammarExtensions);
    }

    return grammarExtensions;
}

/**
 * Languages capable of parsing comments via TextMate
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

    // Explicitly add TypeScript/JavaScript support to ensure these languages
    // are always available, as grammar definitions may not always include
    // the language property in their metadata
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

    // Remove duplicates that may arise from multiple extensions
    // contributing the same language or explicit additions above
    canLanguages = [...new Set(canLanguages)];

    commands.executeCommand(
        "setContext",
        "commentTranslate.canLanguages",
        canLanguages,
    );
    return canLanguages;
}
