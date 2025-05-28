import * as vscode from 'vscode';
import { TgsParser } from './parser/tgs-parser';
import { TgsDiagnosticProvider } from './diagnostics/tgs-diagnostic-provider';
import { TgsCompletionProvider } from './completion/tgs-completion-provider';
import { TgsFormatter } from './formatting/tgs-formatter';

let typegenOutputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
    typegenOutputChannel = vscode.window.createOutputChannel('Typegen');
    context.subscriptions.push(typegenOutputChannel);
    
    const parser = new TgsParser(typegenOutputChannel);
    context.subscriptions.push(parser);

    try {
        await parser.initialize();
        typegenOutputChannel.appendLine('✅ Typegen server started');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        typegenOutputChannel.appendLine(`❌ Failed to connect to Typegen server: ${errorMessage}`);
        typegenOutputChannel.show();
        return;
    }

    const diagnosticProvider = new TgsDiagnosticProvider(context, parser);
    
    // Simple text change validation with debounce
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'tgs' && event.contentChanges.length > 0) {
                // Validate with current document content
                diagnosticProvider.validateDocument(event.document);
            }
        })
    );

    // Validate on save immediately
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'tgs') {
                diagnosticProvider.validateDocument(document, true);
            }
        })
    );

    const completionProvider = new TgsCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'tgs', scheme: 'file' },
            completionProvider,
            ':', '<', '&', ' ', '=', '{', '"', "'"
        )
    );

    // Register formatter
    const formatter = new TgsFormatter();
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(
            { language: 'tgs', scheme: 'file' },
            formatter
        )
    );

    const showOutputCommand = vscode.commands.registerCommand('typegen.showOutput', () => {
        typegenOutputChannel.show();
    });
    context.subscriptions.push(showOutputCommand);

    const restartTypegenServerCommand = vscode.commands.registerCommand('typegen.restartTypegenServer', async () => {
        parser.dispose();
        try {
            await parser.initialize();
            typegenOutputChannel.appendLine('✅ Typegen server restarted successfully');
            
            // Re-validate all open .tgs files
            const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'tgs');
            for (const doc of openDocuments) {
                diagnosticProvider.validateDocument(doc, true);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            typegenOutputChannel.appendLine(`❌ Failed to restart Typegen server: ${errorMessage}`);
            typegenOutputChannel.show();
        }
    });
    context.subscriptions.push(restartTypegenServerCommand);

    // Validate currently open .tgs files
    const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'tgs');
    for (const doc of openDocuments) {
        diagnosticProvider.validateDocument(doc, true);
    }
    
    typegenOutputChannel.appendLine('Typegen extension activation complete');
}
