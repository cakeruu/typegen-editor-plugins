import * as vscode from 'vscode';
import { TgsParser } from '../parser/tgs-parser';

export class TgsDiagnosticProvider {
    private parser: TgsParser;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private validationTimeout: Map<string, NodeJS.Timeout> = new Map();
    private readonly DEBOUNCE_TIME = 100; // Reduced to 100ms for faster feedback
    
    constructor(context: vscode.ExtensionContext, parser: TgsParser) {
        this.parser = parser;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('tgs');
        context.subscriptions.push(this.diagnosticCollection);
    }

    async validateDocument(document: vscode.TextDocument, immediate: boolean = false): Promise<void> {
        if (document.languageId !== 'tgs') {
            return;
        }

        const uri = document.uri.toString();
        
        // Cancel any pending validation
        const existingTimeout = this.validationTimeout.get(uri);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.validationTimeout.delete(uri);
        }

        const doValidation = async () => {
            try {
                // IMPORTANT: Always pass the document to get current content
                const result = await this.parser.parseFile(document.fileName, document);
                
                // Clear existing diagnostics
                this.diagnosticCollection.delete(document.uri);
                
                if (!result.success && result.errors?.length) {
                    const diagnostics = this.parser.parseErrorsToDiagnostics(result.errors, document);
                    this.diagnosticCollection.set(document.uri, diagnostics);
                } else {
                    // Clear diagnostics on successful validation
                }
            } catch (error) {
                this.diagnosticCollection.set(document.uri, [
                    new vscode.Diagnostic(
                        new vscode.Range(0, 0, 0, 1),
                        `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
                        vscode.DiagnosticSeverity.Error
                    )
                ]);
            }
        };

        if (immediate) {
            await doValidation();
        } else {
            const timeout = setTimeout(doValidation, this.DEBOUNCE_TIME);
            this.validationTimeout.set(uri, timeout);
        }
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
        
        for (const timeout of this.validationTimeout.values()) {
            clearTimeout(timeout);
        }
        this.validationTimeout.clear();
    }
} 