# Comment Translate Plus

This is an enhanced fork of [vscode-comment-translate](https://github.com/intellism/vscode-comment-translate) by intellism.

## Improvements over the original

- ✨ **Fixed**: TypeScript/TSX support in browse mode on local environments
- The original extension only worked in remote (SSH/WSL/Container) environments for TypeScript/TSX files
- This enhanced version enables browse mode translation for TypeScript/TSX in all environments
- Future improvements and features planned

## Credits

This project is based on the excellent work by [intellism](https://github.com/intellism).
Thank you for creating the original extension!

## Why a Fork?

This is maintained as an independent project to provide faster bug fixes and continuous improvements to the community while respecting the original work.

---

![Licence](https://img.shields.io/github/license/j4rviscmd/comment-translate-plus.svg)

Translate comments, strings, and code directly in VSCode. Supports multiple translation services.

![Introduction](./doc/image/Introduction.gif)

## Features

### Hover Translation

Hover over comments, strings, or selections to see translations instantly.

### Immersive Reading

Auto-translate comments inline. Toggle display mode with `Ctrl+Shift+B`.

![Immersive](./doc/image/Immersive.gif)

### Variable Naming Translation

Translate descriptions to English variable names.

![naming](<./doc/image/full naming.gif>)

### Hover Replacement

Replace text directly from hover box.

![hover](./doc/image/hover_image.png)

### Full Text Replacement

One-click translation for strings, comments, and selections.

![replace](./doc/image/replace.png)

### GitHub Copilot Chat: @translate

> Requires GitHub Copilot Chat extension

Translate using Copilot AI in Chat box.

![copilot](./doc/image/copilot.gif)

## Shortcuts

| Command | Shortcut |
|---------|----------|
| Toggle immersive translation | `Ctrl+Shift+Z` |
| Toggle display mode | `Ctrl+Shift+B` |
| Variable naming | `Ctrl+Shift+N` |
| Translate & replace | `Ctrl+Shift+T` |
| Copilot quick translate | `Ctrl+Shift+Y` |

> View all commands: Mac `Ctrl+Shift+?` / Windows `Alt+Shift+?`

## Translation Services

- **Google Translate** (default) - Free, requires network
- **Bing Translate** - Free alternative
- **AliCloud Translate** - Requires API credentials

Search `@tag:translateSource` in marketplace for more options. [Details](https://github.com/intellism/vscode-comment-translate/wiki/Translation-Service)

## Key Settings

- `commentTranslate.targetLanguage` - Set target language
- `commentTranslate.source` - Choose translation service
- `commentTranslate.hover.enabled` - Toggle hover translation
- `commentTranslate.hover.concise` - Ctrl/Cmd to trigger hover
- `commentTranslate.browse.enabled` - Immersive browsing mode

## Support

⭐ [Star on GitHub](https://github.com/j4rviscmd/comment-translate-plus) · 💬 Submit feedback · 🔗 Share with others

## License

MIT License - See [LICENSE](./LICENSE) file for details.

- Original work: Copyright (c) intellism
- Modified work: Copyright (c) 2026 j4rviscmd
