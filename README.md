# Typegen Editor Plugins

This repository hosts editor plugins for [Typegen](https://github.com/cakeruu/typegen), a tool for generating type definitions from a schema. The goal is to provide enhanced development experiences for `.tgs` files across various popular code editors.

## Vision

While the initial focus has been on Visual Studio Code, the long-term vision is to support a wider range of editors. We aim to provide a consistent and powerful feature set for Typegen users, regardless of their preferred development environment.

Contributions for new editor plugins or improvements to existing ones are highly encouraged!

## Official Typegen Repository

For more information about Typegen itself, its syntax, and its capabilities, please refer to the official repository:
[cakeruu/typegen](https://github.com/cakeruu/typegen)

## Currently Supported Editors

### Visual Studio Code

The VS Code extension (`vscode-extension` directory) provides comprehensive language support for `.tgs` files.

**Features:**

*   **Syntax Highlighting:** Clear and effective highlighting for `.tgs` syntax.
*   **Snippets:** Predefined snippets for common Typegen constructs.
*   **Daemon-based Parsing:** Leverages the `typegen` daemon for fast and accurate parsing and error checking.
*   **Real-time Diagnostics:** Displays errors and warnings directly in the editor.
*   **Intelligent Completions:** Offers context-aware suggestions for keywords, types, schemas, enums, and import paths.
*   **Commands:** Includes commands for managing the Typegen daemon and viewing output.

**Developing the VS Code Extension:**

1.  Clone this repository: `git clone https://github.com/cakeruu/typegen-editor-plugins.git`
2.  Navigate to the VS Code extension directory: `cd typegen-editor-plugins/vscode-extension`
3.  Install dependencies: `npm install`.
4.  Open the `vscode-extension` folder in VS Code.
5.  Press `F5` to launch an Extension Development Host window with the extension running.

    Key files for development:
    *   `src/extension.ts`: Main extension logic, including interaction with the Typegen daemon.
    *   `package.json`: Defines extension manifest, commands, and language contributions.
    *   `syntaxes/tgs.tmLanguage.json`: TextMate grammar for syntax highlighting.
    *   `language-configuration.json`: Basic language features like comments and brackets.

**Installation (VS Code):**

*   Search for "Typegen Language" in the Visual Studio Code Marketplace.
*   Alternatively, you can install from a `.vsix` file (e.g., `typegen-language-1.0.1.vsix` found in the `vscode-extension` directory) by going to the Extensions view, clicking "...", and selecting "Install from VSIX...".

## Planned Editor Support

We are planning to extend support to other editors. If you are interested in contributing a plugin for an editor not listed, please open an issue or a pull request!

## License

Each editor plugin may have its own license. For the VS Code extension, refer to the `LICENSE.md` file in the `vscode-extension` directory.
