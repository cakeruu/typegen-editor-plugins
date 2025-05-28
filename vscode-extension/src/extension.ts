import * as vscode from 'vscode';
import { TgsParser } from './parser/tgs-parser';
import { TgsDiagnosticProvider } from './diagnostics/tgs-diagnostic-provider';
import { TgsCompletionProvider } from './completion/tgs-completion-provider';
import { TgsFormatter } from './formatting/tgs-formatter';

let typegenOutputChannel: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
    typegenOutputChannel = vscode.window.createOutputChannel('Typegen');
    context.subscriptions.push(typegenOutputChannel);
    
    // Register commands first - these should always be available
    const showOutputCommand = vscode.commands.registerCommand('typegen.showOutput', () => {
        typegenOutputChannel.show();
    });
    context.subscriptions.push(showOutputCommand);

    const parser = new TgsParser(typegenOutputChannel);
    context.subscriptions.push(parser);

    const restartTypegenServerCommand = vscode.commands.registerCommand('typegen.restartTypegenServer', async () => {
        parser.dispose();
        try {
            await parser.initialize();
            typegenOutputChannel.appendLine('✅ Typegen server restarted successfully');
            
            // Re-validate all open .tgs files
            const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'tgs');
            for (const doc of openDocuments) {
                if (diagnosticProvider) {
                    diagnosticProvider.validateDocument(doc, true);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            typegenOutputChannel.appendLine(`❌ Failed to restart Typegen server: ${errorMessage}`);
            
            // Show special message for missing executable
            if (errorMessage.includes('not found') || errorMessage.includes('ENOENT')) {
                typegenOutputChannel.appendLine('💡 To install Typegen, run: npm install -g @cakeru/typegen');
            }
        }
    });
    context.subscriptions.push(restartTypegenServerCommand);

    // Initialize parser - if this fails, stop here
    let diagnosticProvider: TgsDiagnosticProvider | null = null;
    
    try {
        await parser.initialize();
        typegenOutputChannel.appendLine('✅ Typegen server started');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        typegenOutputChannel.appendLine(`❌ Failed to connect to Typegen server: ${errorMessage}`);
        
        // Special handling for missing executable
        if (errorMessage.includes('not found') || errorMessage.includes('ENOENT')) {
            typegenOutputChannel.show();
            typegenOutputChannel.appendLine('💡 Typegen is not installed or not found in PATH.');
            typegenOutputChannel.appendLine('💡 To install Typegen, run: npm install -g @cakeru/typegen');
            typegenOutputChannel.appendLine('💡 After installation, use "Typegen: Restart Typegen Server" command to retry.');
        }        
        return;
    }
        
    // Only set up language features if parser initialized successfully
    diagnosticProvider = new TgsDiagnosticProvider(context, parser);
    
    // Simple text change validation with debounce
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'tgs' && event.contentChanges.length > 0) {
                // Validate with current document content
                diagnosticProvider?.validateDocument(event.document);
            }
        })
    );

    // Validate on save immediately
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'tgs') {
                diagnosticProvider?.validateDocument(document, true);
            }
        })
    );

    // Register completion provider and formatter
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

    // Validate currently open .tgs files
    const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'tgs');
    for (const doc of openDocuments) {
        diagnosticProvider.validateDocument(doc, true);
    }
    
    typegenOutputChannel.appendLine('Typegen extension activation complete');
}
