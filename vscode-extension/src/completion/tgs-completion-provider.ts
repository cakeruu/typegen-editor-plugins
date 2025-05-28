import * as vscode from 'vscode';
import * as path from 'path';
import { TGS_TYPES } from '../utils/constants';

interface DocumentSymbols {
    schemas: Set<string>;
    enums: Set<string>;
}

export class TgsCompletionProvider implements vscode.CompletionItemProvider {
    private documentSymbols: Map<string, DocumentSymbols> = new Map();

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        if (token.isCancellationRequested) {
            return undefined;
        }
        
        await this.updateDocumentSymbols(document);
        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        let importPathMatch = linePrefix.match(/from\s+['"]([^'"]*)/);
        if (importPathMatch) {
            return this.providePathCompletions(document, position, importPathMatch[1]);
        }
        
        let importSchemaMatch = linePrefix.match(/import\s*{\s*([^}]*)/);
        if (importSchemaMatch) {
            return this.provideImportSymbolCompletions(document, position, importSchemaMatch[1]);
        }
        
        if (linePrefix.match(/:\s*\w*$/)) {
            return this.provideTypeCompletions(document, position);
        }
        
        if (linePrefix.match(/create\s+schema\s+\w+\s*<([^>]*)$/)) {
            return this.provideDirCompletions(document, position);
        }
        
        if (linePrefix.match(/&\s*\w*$/)) {
            return this.provideSchemaCompletions(document, position);
        }
        
        if (linePrefix.trim() === '' || linePrefix.trim().match(/^c/)) {
            return this.provideKeywordCompletions();
        }
        
        return undefined;
    }

    private async providePathCompletions(
        document: vscode.TextDocument, position: vscode.Position, currentPath: string
    ): Promise<vscode.CompletionItem[]> {
        const items: vscode.CompletionItem[] = [];
        try {
            const currentDir = path.dirname(document.uri.fsPath);
            const searchDir = currentPath.includes('/') ? 
                path.resolve(currentDir, path.dirname(currentPath)) : currentDir;
            
            const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(searchDir));
            
            for (const [name, type] of files) {
                if (type === vscode.FileType.Directory) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Folder);
                    item.insertText = name + '/';
                    items.push(item);
                } else if (name.endsWith('.tgs')) {
                    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.File);
                    items.push(item);
                }
            }
        } catch (error) {
            // Silently handle errors
        }
        return items;
    }

    private async provideImportSymbolCompletions(
        document: vscode.TextDocument, position: vscode.Position, currentInput: string
    ): Promise<vscode.CompletionItem[]> {
        const line = document.lineAt(position).text;
        const pathMatch = line.match(/from\s+["']([^"']*)["']/);
        if (!pathMatch) {
            return [];
        }
        
        const importPath = pathMatch[1];
        
        try {
            const currentDir = path.dirname(document.uri.fsPath);
            const fullPath = path.resolve(currentDir, importPath);
            
            const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
            const content = Buffer.from(fileContent).toString('utf-8');
            
            const items: vscode.CompletionItem[] = [];
            
            const schemaRegex = /create\s+schema\s+(\w+)/g;
            let match;
            while ((match = schemaRegex.exec(content)) !== null) {
                const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Class);
                item.detail = 'Schema';
                items.push(item);
            }
            
            const enumRegex = /create\s+enum\s+(\w+)/g;
            while ((match = enumRegex.exec(content)) !== null) {
                const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Enum);
                item.detail = 'Enum';
                items.push(item);
            }
            
            return items;
        } catch (error) {
            return [];
        }
    }

    private provideDirCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const item = new vscode.CompletionItem('/', vscode.CompletionItemKind.Folder);
        item.detail = 'Root directory';
        items.push(item);
        return items;
    }

    private provideSchemaCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const symbols = this.documentSymbols.get(document.uri.toString());
        if (!symbols) {
            return [];
        }
        
        const items = Array.from(symbols.schemas).map(schema => {
            const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Class);
            item.detail = 'Schema';
            return item;
        });
        
        return items;
    }

    private provideTypeCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        
        // Add built-in types
        for (const type of TGS_TYPES) {
            const item = new vscode.CompletionItem(type, vscode.CompletionItemKind.TypeParameter);
            item.detail = `Built-in type: ${type}`;
            items.push(item);
        }
        
        const symbols = this.documentSymbols.get(document.uri.toString());
        if (symbols) {
            for (const schema of symbols.schemas) {
                const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Class);
                item.detail = 'Schema type';
                items.push(item);
            }
            for (const enumName of symbols.enums) {
                const item = new vscode.CompletionItem(enumName, vscode.CompletionItemKind.Enum);
                item.detail = 'Enum type';
                items.push(item);
            }
        }
        
        return items;
    }

    private provideKeywordCompletions(): vscode.CompletionItem[] {
        const keywords = [
            { 
                label: 'create schema', 
                detail: 'Create a new schema definition', 
                snippet: 'create schema ${1:SchemaName}<${2:directory}>(\n\t${0}\n);' 
            },
            { 
                label: 'create enum', 
                detail: 'Create a new enum definition', 
                snippet: 'create enum ${1:EnumName}<${2:directory}>(\n\t${0}\n);' 
            },
            { 
                label: 'import', 
                detail: 'Import schemas and enums from another file', 
                snippet: 'import { $1 } from "$2";' 
            }
        ];
        
        const items = keywords.map(keyword => {
            const item = new vscode.CompletionItem(keyword.label, vscode.CompletionItemKind.Keyword);
            item.detail = keyword.detail;
            if (keyword.snippet) {
                item.insertText = new vscode.SnippetString(keyword.snippet);
            }
            return item;
        });
        
        return items;
    }

    private async updateDocumentSymbols(document: vscode.TextDocument): Promise<void> {
        const uri = document.uri.toString();
        const symbols: DocumentSymbols = { 
            schemas: new Set<string>(), 
            enums: new Set<string>() 
        };
        
        const content = document.getText();
        
        const schemaRegex = /create\s+schema\s+(\w+)/g;
        let match;
        while ((match = schemaRegex.exec(content)) !== null) {
            symbols.schemas.add(match[1]);
        }
        
        const enumRegex = /create\s+enum\s+(\w+)/g;
        while ((match = enumRegex.exec(content)) !== null) {
            symbols.enums.add(match[1]);
        }
        
        this.documentSymbols.set(uri, symbols);
    }
} 