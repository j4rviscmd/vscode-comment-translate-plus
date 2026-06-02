import {
    CancellationToken,
    commands,
    Diagnostic,
    ExtensionContext,
    Hover,
    languages,
    MarkdownString,
    Position,
    Range,
    TextDocument,
    window,
} from "vscode";
import { getConfig } from "../configuration";
import { /* client,*/  outputChannel } from "../extension";
import { ShortLive } from "../util/short-live";
import { compileBlock } from "../syntax/compile";
import { compileMarkdown, getMarkdownTextValue } from "../syntax/marked";
import { ICommentBlock } from "../interface";
import { createComment } from "../syntax/Comment";

/** Short-lived cache used to implement concise hover mode (Ctrl/Cmd-triggered translation). */
export let shortLive = new ShortLive<string>((prev, curr) => prev === curr);

/** Tracks the most recent hover range per document URI for external consumers. */
let last: Map<string, Range> = new Map();

/** Set of hover identifiers currently being processed, used to prevent recursive hover calls. */
let working: Set<String> = new Set();

/**
 * Provides hover translation for comments, strings, and selected text regions.
 *
 * Attempts to locate a translatable block at the given position by checking:
 * 1. Active editor text selections
 * 2. Markdown document content
 * 3. Language-specific comment blocks
 *
 * @param document - The text document being hovered over
 * @param position - The cursor position within the document
 * @param _token - Cancellation token (unused)
 * @param canLanguages - List of language IDs that support comment extraction
 * @returns A Hover containing the translated text, or null if nothing to translate
 */
async function commentProvideHover(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    canLanguages: string[],
): Promise<Hover | null> {
    const uri = document.uri.toString();

    const concise = getConfig<boolean>("hover.concise");
    const nearShow = getConfig<boolean>("hover.nearShow");

    if (concise && !shortLive.isLive(uri)) return null;

    let block: ICommentBlock | null = selectionContains(uri, position);
    let res: { md: MarkdownString, header: MarkdownString } | undefined;
    let range: Range | undefined;

    if (!block) {
        if (document.languageId === "markdown") {
            if (document.languageId !== "markdown") return null;
            let { translatedText, range: MarkdwonRange } = await compileMarkdown(document, position);
            res = createHoverMarkdownString(
                translatedText,
                '',
                uri,
                MarkdwonRange,
                document,
                ''
            );
            range = MarkdwonRange;
        } else if (canLanguages.includes(document.languageId)) {
            try {
                let comment = await createComment();
                block = await comment.getComment(document, position);
            } catch (e) {
                //@ts-ignore
                outputChannel.append("\n" + e.message);
            }

            if (!block) {
                return null;
            }
        }
    }


    if (block) {
        const translatedBlock = await compileBlock(block, document.languageId);
        const { translatedText, translateLink, humanizeText } = translatedBlock;
        range = block.range;
        res = createHoverMarkdownString(
            translatedText,
            humanizeText,
            uri,
            range,
            document,
            translateLink
        );
    }

    if (!res) return null;
    if (!range) return null;

    let showRange = range;
    if (nearShow) {
        const nearRange = new Range(
            new Position(position.line, Math.max(position.character - 10, 0)),
            new Position(position.line, position.character + 10)
        );
        showRange = range.intersection(nearRange) || showRange;
    }

    const contents: MarkdownString[] = [];
    if (res.header.value.length > 0) {
        contents.push(res.header);
    }
    contents.push(res.md);
    const hover = new Hover(contents, showRange);
    last.set(uri, range);
    return hover;
}

/**
 * Provides hover translation for type language content by delegating to VS Code's
 * built-in hover providers and translating their markdown output.
 *
 * Uses `vscode.executeHoverProvider` to gather native hover results, then translates
 * each markdown content block. Results with no translatable text are filtered out.
 * Uses the `working` set to prevent recursive calls from re-entering this provider.
 *
 * @param document - The text document being hovered over
 * @param position - The cursor position within the document
 * @param _token - Cancellation token (unused)
 * @param canLanguages - List of language IDs that support type language hover
 * @returns A Hover with translated type language content, or null if nothing to translate
 */
async function translateTypeLanguageProvideHover(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    canLanguages: string[]
): Promise<Hover | null> {

    // Return null if the current document does not support type language
    if (canLanguages.indexOf(document.languageId) < 0) return null;

    // translateTypeLanguage的开关，默认开启
    const typeLanguae = getConfig<boolean>("hover.content");
    if (!typeLanguae) return null;

    let hoverId = getHoverId(document, position);
    working.add(hoverId); // 标识当前位置进行处理中。  当前Provider将忽略当次请求，规避循环调用。
    let res = await commands.executeCommand<Hover[]>(
        "vscode.executeHoverProvider",
        document.uri,
        position
    );
    working.delete(hoverId); // 移除处理中的标识，使其他正常hover的响应
    // let targetLanguage = getConfig<string>('targetLanguage', userLanguage);

    // let contents:{tokens:IMarkdownReplceToken[]}[] = [];
    let contentTasks: Promise<{ result: string; hasTranslated: boolean }>[] =
        [];
    let range: Range | undefined;

    res.forEach((hover) => {
        range = range || hover.range;
        hover.contents.forEach(async (c) => {
            // TODO 先全量翻译,后续特殊场景定制优化
            let markdownText: string;
            // let tokens:IMarkdownReplceToken[];
            if (typeof c === "string") {
                markdownText = c;
            } else {
                markdownText = c.value;
            }
            contentTasks.push(getMarkdownTextValue(markdownText));
        });
    });

    let translateds = await Promise.all(contentTasks);

    let markdownStrings: MarkdownString[] = [];
    let i = 0;
    // 如果Hover分组中，所有内容都没有翻译，忽略这部分片段内容。
    res.forEach((hover) => {
        let hasTranslated = false;
        let temp: MarkdownString[] = [];
        for (let j = 0; j < hover.contents.length; j += 1) {
            let md = new MarkdownString(translateds[i].result, true);
            md.isTrusted = true;
            temp.push(md);
            if (translateds[i].hasTranslated === true) {
                hasTranslated = true;
            }
            i += 1;
        }
        if (hasTranslated) {
            markdownStrings = markdownStrings.concat(...temp);
        }
    });

    if (markdownStrings.length > 0) {
        return new Hover(markdownStrings, range);
    }
    return null;
}

/**
 * Provides hover translation for diagnostic messages (errors, warnings) at the given position.
 *
 * Retrieves all diagnostics for the document, filters those whose range contains the position,
 * translates their messages, and formats them with the diagnostic source and code.
 *
 * @param document - The text document being hovered over
 * @param position - The cursor position within the document
 * @returns A Hover with translated diagnostic messages, or null if no diagnostics at position
 */
async function diagnosticsProvideHover(
    document: TextDocument,
    position: Position
): Promise<Hover | null> {
    const diagnostics: Diagnostic[] = languages.getDiagnostics(document.uri);
    const contentTasks: Promise<{ result: string; hasTranslated: boolean }>[] =
        [];
    const filteredDiagnostics: Diagnostic[] = [];

    let range: Range | undefined;
    diagnostics.forEach((diagnostic) => {
        if (diagnostic.range.contains(position)) {
            range = range || diagnostic.range;
            contentTasks.push(getMarkdownTextValue(diagnostic.message));
            filteredDiagnostics.push(diagnostic);
        }
    });

    const translateds = await Promise.all(contentTasks);
    const markdownStrings: MarkdownString[] = [];
    translateds.forEach((translated, index) => {
        if (!translated.hasTranslated) return;
        let diagnostic = filteredDiagnostics[index];

        let codeText: string = "";
        if (
            typeof diagnostic.code === "string" ||
            typeof diagnostic.code === "number"
        ) {
            codeText = `${diagnostic.code}`;
        } else if (
            diagnostic.code &&
            diagnostic.code.value &&
            diagnostic.code.target
        ) {
            codeText = `[${diagnostic.code.value}](${diagnostic.code.target})`;
        }

        if (codeText) {
            codeText = `(${codeText})`;
        }
        const sourceText = `\`${diagnostic.source}\`${codeText}`;
        const md = new MarkdownString(translated.result + sourceText, true);
        md.isTrusted = true;
        markdownStrings.push(md);
    });

    if (markdownStrings.length > 0) {
        return new Hover(markdownStrings, range);
    }

    return null;
}

/**
 * Generates a unique identifier for a hover request based on document URI and position.
 * Used to track in-progress hover requests and prevent recursive calls.
 *
 * @param document - The text document
 * @param position - The cursor position
 * @returns A string identifier in the format `{uri}-{line}-{character}`
 */
function getHoverId(document: TextDocument, position: Position) {
    return `${document.uri.toString()}-${position.line}-${position.character}`;
}

/**
 * Registers the hover provider that supplies translated content for comments,
 * type language hover results, and diagnostic messages.
 *
 * The provider runs all three hover strategies in parallel and merges their results.
 * Guards against recursive invocations using the `working` set and respects the
 * `hover.enabled` configuration setting.
 *
 * @param context - The extension context for managing the provider lifecycle
 * @param canLanguages - List of language IDs that support comment/type translation
 */
export function registerHover(
    context: ExtensionContext,
    canLanguages: string[] = []
) {
    let hoverProviderDisposable = languages.registerHoverProvider(
        '*',
        {
            async provideHover(document, position, token) {
                // hover开关配置，对typelanguage生效
                const open = getConfig<boolean>("hover.enabled");
                if (!open) return null;

                let hoverId = getHoverId(document, position);
                // 如果已经当前Hover进行中，则忽略本次请求
                if (working.has(hoverId)) {
                    return null;
                }

                let [typeLanguageHover, commentHover, diagnosticsHover] =
                    await Promise.all([
                        translateTypeLanguageProvideHover(
                            document,
                            position,
                            token,
                            canLanguages,
                        ),
                        commentProvideHover(document, position, token, canLanguages),
                        diagnosticsProvideHover(document, position),
                    ]);
                return mergeHovers(
                    commentHover,
                    diagnosticsHover,
                    typeLanguageHover
                );
            },
        }
    );
    context.subscriptions.push(hoverProviderDisposable);
}

/**
 * Checks whether the active editor has a non-empty text selection that contains
 * the given position, and returns it as a comment block for translation.
 *
 * @param url - The stringified URI of the document to match against the active editor
 * @param position - The cursor position to check against selections
 * @returns An ICommentBlock representing the selected text, or null if no matching selection
 */
function selectionContains(
    url: string,
    position: Position
): ICommentBlock | null {
    let editor = window.activeTextEditor;
    //有活动editor，并且打开文档与请求文档一致时处理请求
    if (editor && editor.document.uri.toString() === url) {
        //类型转换
        let selection = editor.selections.find((selection) => {
            return !selection.isEmpty && selection.contains(position);
        });

        if (selection) {
            return {
                range: selection,
                comment: editor.document.getText(selection),
            };
        }
    }

    return null;
}

/**
 * Returns the Range of the most recent hover result for the given document URI.
 *
 * @param uri - The stringified URI of the document
 * @returns The Range of the last hover, or undefined if no hover recorded
 */
export function lastHover(uri: string) {
    return last.get(uri);
}

/**
 * Merges multiple Hover results into a single Hover by concatenating their contents.
 * Filters out null entries before merging.
 *
 * @param hovers - Variable number of Hover or null values to merge
 * @returns A single Hover with all contents combined, or null if all inputs are null
 */
function mergeHovers(...hovers: (Hover | null)[]): Hover | null {
    const filteredHovers = hovers.filter((hover) => hover !== null) as Hover[];
    const firstHover = filteredHovers.shift();
    if (!firstHover) return null;

    filteredHovers.forEach((hover) => {
        firstHover.contents = firstHover.contents.concat(hover.contents);
    });

    return firstHover;
}


/**
 * Builds the markdown content for a hover tooltip, including an optional toolbar header
 * with action commands (replace, combine, add selection, change source) and the translated
 * text body formatted as a code block.
 *
 * When `hover.showToolbar` is enabled (default), the header contains clickable icons for
 * common actions. The translated text is displayed in a fenced code block matching the
 * document's language. If a humanized variable name is provided, it is shown alongside
 * the translation.
 *
 * @param translatedText - The translated text to display
 * @param humanizeText - Optional humanized variable name suggestion
 * @param uri - The stringified URI of the source document
 * @param range - The range object with start/end position information
 * @param document - Object containing the language ID for syntax highlighting
 * @param translateLink - Additional markdown link for the translation source
 * @returns An object with `md` (body) and `header` (toolbar) MarkdownString values
 */
function createHoverMarkdownString(
    translatedText: string,
    humanizeText: string | undefined,
    uri: string,
    range: { start: any, end: any },
    document: { languageId: string },
    translateLink: string
): { md: MarkdownString, header: MarkdownString } {
    const showToolbar = getConfig<boolean>("hover.showToolbar");

    const base64TranslatedText = Buffer.from(translatedText).toString("base64");
    const space = "&nbsp;&nbsp;";
    const separator = `${space}|${space}`;
    const replace = `[$(replace)](command:commentTranslate._replaceRange?${encodeURIComponent(
        JSON.stringify({
            uri,
            range: { start: range.start, end: range.end },
            text: base64TranslatedText,
        })
    )} "Replace")`;
    const multiLine = getConfig<boolean>("multiLineMerge");
    const combine = `[$(${multiLine ? "selection" : "remove"
        })](command:commentTranslate._toggleMultiLineMerge "Toggle Combine Multi Line")`;

    // bugfix: JSON.stringify Range会变成数组。 传到下游会有问题。
    const addSelection = `[$(heart)](command:commentTranslate._addSelection?${encodeURIComponent(
        JSON.stringify({ range: { start: range.start, end: range.end } })
    )} "Add Selection")`;

    const translate = `[$(sync)](command:commentTranslate.changeTranslateSource "Change translate source")`;

    const headerText = showToolbar !== false
        ? `[Comment Translate]${space}${replace}${space}${combine}${space}${addSelection}${separator}${translate}${space}${translateLink}`
        : "";
    const header = new MarkdownString(headerText, true);
    header.isTrusted = true;

    let showText = translatedText;
    if (humanizeText) {
        showText = `${humanizeText} => ${translatedText}`;
    }
    const codeDefine = "```";
    let md = new MarkdownString(
        `${codeDefine}${document.languageId}\n${showText}\n ${codeDefine}`
    );
    if (!translatedText) {
        md = new MarkdownString(
            `**Translate Error**: Check [OutputPannel](command:commentTranslate._openOutputPannel "open output pannel") for details.`
        );
        md.isTrusted = true;
    }

    return { header, md };
}
