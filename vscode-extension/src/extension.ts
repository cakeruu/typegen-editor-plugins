import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface ParseResult {
    success: boolean;
    errors: string[];
    schemas?: number;
    enums?: number;
    imports?: number;
    file?: string;
}

let typegenOutputChannel: vscode.OutputChannel;

// Constants for TGS types
const TGS_TYPES = [
    'Uid', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
    'byte', 'sbyte', 'float', 'double', 'decimal', 'bool',
    'char', 'object', 'string', 'Array', 'List', 'Map',
    'Set', 'Queue', 'Date', 'DateTime'
] as const;

type TGSType = typeof TGS_TYPES[number];

interface PendingRequest {
    filePath: string;
    resolve: (value: ParseResult) => void;
    reject: (reason?: any) => void;
    timestamp: number;
}

export class TgsParser implements vscode.Disposable {
    private parserPath: string = 'typegen';
    private outputChannel!: vscode.OutputChannel;
    private daemonProcess: ChildProcess | null = null;
    private isDaemonReady: boolean = false;
    private requestQueue: PendingRequest[] = [];
    private stdoutBuffer: string = '';
    private static instance: TgsParser | null = null;
    private initializationPromise: Promise<void> | null = null;
    private requestId: number = 0;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private isProcessingBuffer: boolean = false;
    
    constructor(outputChannel: vscode.OutputChannel) {
        if (TgsParser.instance) {
            return TgsParser.instance;
        }
        this.outputChannel = outputChannel;
        TgsParser.instance = this;
        return this;
    }

    public initialize(): Promise<void> {
        if (this.isDaemonReady && this.daemonProcess) {
            return Promise.resolve();
        }

        if (!this.initializationPromise) {
            this.initializationPromise = this.startDaemon();
        }
        return this.initializationPromise;
    }

    private startDaemon(): Promise<void> {
        return new Promise((resolveInitialize, rejectInitialize) => {
            if (this.isDaemonReady && this.daemonProcess) {
                resolveInitialize();
                return;
            }

            this.outputChannel.appendLine(`Starting Typegen daemon: ${this.parserPath} parse --json --daemon`);
            this.outputChannel.show(); // Show output immediately
            
            // Use detached: false and stdio configuration for better performance
            this.daemonProcess = spawn(this.parserPath, ['parse', '--json', '--daemon'], { 
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: false,
                shell: process.platform === 'win32' // Use shell on Windows for better compatibility
            });

            if (!this.daemonProcess) {
                const errorMsg = 'Failed to spawn Typegen daemon process.';
                this.outputChannel.appendLine(`❌ ${errorMsg}`);
                this.rejectAllPending(new Error(errorMsg));
                rejectInitialize(new Error(errorMsg));
                return;
            }

            // Add timeout for daemon startup
            const startupTimeout = setTimeout(() => {
                if (!this.isDaemonReady) {
                    const timeoutMsg = 'Daemon startup timeout - daemon did not respond within 10 seconds';
                    this.outputChannel.appendLine(`❌ ${timeoutMsg}`);
                    if (this.daemonProcess) {
                        this.daemonProcess.kill();
                    }
                    this.isDaemonReady = false;
                    this.daemonProcess = null;
                    rejectInitialize(new Error(timeoutMsg));
                    this.initializationPromise = null;
                }
            }, 10000); // 10 second timeout

            // Set up error handling
            this.daemonProcess.on('error', (err: NodeJS.ErrnoException) => {
                clearTimeout(startupTimeout);
                this.outputChannel.appendLine(`❌ Typegen daemon error: ${err.message}`);
                this.isDaemonReady = false;
                this.daemonProcess = null;
                const errorMsg = err.code === 'ENOENT' ? 
                    `Typegen command ('${this.parserPath}') not found. Please ensure Typegen is installed and in your system's PATH.` :
                    `Daemon error: ${err.message}`;
                this.outputChannel.appendLine(`❌ ${errorMsg}`);
                this.rejectAllPending(new Error(errorMsg));
                rejectInitialize(new Error(errorMsg));
                this.initializationPromise = null;
            });

            this.daemonProcess.on('close', (code) => {
                clearTimeout(startupTimeout);
                this.outputChannel.appendLine(`❌ Typegen daemon process closed (code: ${code})`);
                this.isDaemonReady = false;
                this.daemonProcess = null;
                const errorMsg = `Daemon process closed (code: ${code})`;
                this.rejectAllPending(new Error(errorMsg));
                if (!this.isDaemonReady) {
                    rejectInitialize(new Error(errorMsg));
                }
                this.initializationPromise = null;
            });

            this.daemonProcess.on('spawn', () => {
                this.outputChannel.appendLine(`✅ Daemon process spawned successfully`);
            });

            // Handle stderr
            if (this.daemonProcess.stderr) {
                this.daemonProcess.stderr.setEncoding('utf8');
                this.daemonProcess.stderr.on('data', (data) => {
                    const errorText = data.toString().trim();
                });
            }

            // Optimized stdout handling
            if (this.daemonProcess.stdout) {
                this.daemonProcess.stdout.setEncoding('utf8');
                this.daemonProcess.stdout.on('data', (data: string) => {
                    // Remove verbose logging of raw daemon output
                    this.stdoutBuffer += data;
                    // Use setImmediate to avoid blocking the event loop
                    if (!this.isProcessingBuffer) {
                        setImmediate(() => this.processStdoutBuffer(resolveInitialize, rejectInitialize, startupTimeout));
                    }
                });
            } else {
                clearTimeout(startupTimeout);
                const errorMsg = 'Daemon stdout stream is not available.';
                this.outputChannel.appendLine(`❌ ${errorMsg}`);
                this.rejectAllPending(new Error(errorMsg));
                rejectInitialize(new Error(errorMsg));
            }
        });
    }

    private processStdoutBuffer(resolveInitialize?: () => void, rejectInitialize?: (reason?: any) => void, startupTimeout?: NodeJS.Timeout) {
        if (this.isProcessingBuffer) {return;}
        this.isProcessingBuffer = true;

        try {
            // Process multiple JSON objects if they exist in the buffer
            const lines = this.stdoutBuffer.split('\n');
            this.stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (!line.trim()) {continue;}
                
                try {
                    const result = JSON.parse(line);
                    // Remove verbose JSON logging
                    
                    if (result.status === 'ready') {
                        this.isDaemonReady = true;
                        this.outputChannel.appendLine('✅ Daemon is ready!');
                        if (startupTimeout) {
                            clearTimeout(startupTimeout);
                        }
                        if (resolveInitialize) {
                            resolveInitialize();
                            resolveInitialize = undefined; // Prevent multiple calls
                        }
                        continue;
                    }

                    // Process regular parsing results
                    const request = this.requestQueue.shift();
                    if (request) {
                        // Optimize error processing
                        if (result.errors?.length) {
                            result.errors = this.processErrors(result.errors);
                        }
                        request.resolve(result as ParseResult);
                    }
                } catch (parseError) {
                    // Only log actual parse errors, not raw data
                    this.outputChannel.appendLine(`Error parsing daemon response: ${parseError}`);
                    continue;
                }
            }
        } finally {
            this.isProcessingBuffer = false;
        }
    }

    // Optimized error processing
    private processErrors(errors: string[]): string[] {
        const replacements: Array<[RegExp, string]> = [
            [/\\u003CSPACE\\u003E/g, '<SPACE>'],
            [/\\u003C/g, '<'],
            [/\\u003E/g, '>'],
            [/\\u0027/g, "'"]
        ];

        return errors.map(error => {
            let processedError = error;
            for (const [regex, replacement] of replacements) {
                processedError = processedError.replace(regex, replacement);
            }
            return processedError;
        });
    }

    async parseFile(filePath: string): Promise<ParseResult> {
        // Check if daemon is ready
        if (!this.isDaemonReady || !this.daemonProcess?.stdin?.writable) {
            if (!this.initializationPromise) {
                this.initializationPromise = this.startDaemon();
            }
            await this.initializationPromise;
        }

        // Check for duplicate requests to avoid redundant parsing
        const requestKey = filePath;
        if (this.pendingRequests.has(requestKey)) {
            // Return the existing promise
            const existingRequest = this.pendingRequests.get(requestKey)!;
            return new Promise((resolve, reject) => {
                const originalResolve = existingRequest.resolve;
                const originalReject = existingRequest.reject;
                
                existingRequest.resolve = (value) => {
                    originalResolve(value);
                    resolve(value);
                };
                existingRequest.reject = (reason) => {
                    originalReject(reason);
                    reject(reason);
                };
            });
        }

        return new Promise((resolve, reject) => {
            const request: PendingRequest = {
                filePath,
                resolve: (value) => {
                    this.pendingRequests.delete(requestKey);
                    resolve(value);
                },
                reject: (reason) => {
                    this.pendingRequests.delete(requestKey);
                    reject(reason);
                },
                timestamp: Date.now()
            };

            this.pendingRequests.set(requestKey, request);
            this.requestQueue.push(request);
            
            // Send request to daemon
            this.daemonProcess!.stdin!.write(filePath + '\n', (err) => {
                if (err) {
                    this.handleFailedRequest(filePath, new Error(err.message));
                }
            });
        });
    }

    private handleFailedRequest(filePath: string, error: Error) {
        const requestIndex = this.requestQueue.findIndex(req => req.filePath === filePath);
        if (requestIndex > -1) {
            const request = this.requestQueue.splice(requestIndex, 1)[0];
            this.pendingRequests.delete(filePath);
            request.reject(error);
        }
    }

    private rejectAllPending(error: Error) {
        this.requestQueue.forEach(req => req.reject(error));
        this.pendingRequests.clear();
        this.requestQueue = [];
    }

    public dispose() {
        if (this.daemonProcess) {
            this.outputChannel.appendLine('Disposing Typegen daemon process.');
            this.daemonProcess.kill();
            this.daemonProcess = null;
        }
        this.isDaemonReady = false;
        this.rejectAllPending(new Error('Typegen daemon disposed.'));
        this.initializationPromise = null;
    }
    
    parseErrorsToDiagnostics(errors: string[], document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const lineCount = document.lineCount;
        
        for (const error of errors) {
            const parts = error.split('<SPACE>', 2);
            if (parts.length !== 2) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 1),
                    error,
                    vscode.DiagnosticSeverity.Error
                ));
                continue;
            }

            const parsedLine = parseInt(parts[0], 10);
            if (isNaN(parsedLine)) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 1),
                    error,
                    vscode.DiagnosticSeverity.Error
                ));
                continue;
            }

            const line = Math.max(0, Math.min(parsedLine - 1, lineCount - 1));
            const specificLine = document.lineAt(line);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(
                    line,
                    specificLine.firstNonWhitespaceCharacterIndex,
                    line,
                    specificLine.text.length
                ),
                parts[1],
                vscode.DiagnosticSeverity.Error
            ));
        }
        
        return diagnostics;
    }
}

/**
 * VSCode extension diagnostic provider for .tgs files
 */
export class TgsDiagnosticProvider {
    private parser: TgsParser;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private validationTimeout: Map<string, NodeJS.Timeout> = new Map();
    private readonly DEBOUNCE_TIME = 150; // Increased debounce for better performance
    private pendingValidations = new Set<string>();
    private lastValidationTime = new Map<string, number>();
    private readonly MIN_VALIDATION_INTERVAL = 10; // Minimum time between validations
    
    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel, parser: TgsParser) {
        this.parser = parser;
        this.diagnosticCollection = vscode.languages.createDiagnosticCollection('tgs');
        context.subscriptions.push(this.diagnosticCollection);
    }
    
    async validateDocument(document: vscode.TextDocument, immediate: boolean = false): Promise<void> {
        if (document.languageId !== 'tgs') {return;}

        const uri = document.uri.toString();
        const now = Date.now();
        
        // Rate limiting: skip if validated too recently (unless immediate)
        if (!immediate) {
            const lastValidation = this.lastValidationTime.get(uri) || 0;
            if (now - lastValidation < this.MIN_VALIDATION_INTERVAL) {
                return;
            }
        }
        
        // Cancel any pending validation
        const existingTimeout = this.validationTimeout.get(uri);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
            this.validationTimeout.delete(uri);
        }

        // Skip if there's already a validation in progress and not immediate
        if (this.pendingValidations.has(uri) && !immediate) {
            return;
        }

        const doValidation = async () => {
            // Double-check to avoid race conditions
            if (!immediate && this.pendingValidations.has(uri)) {
                return;
            }
            
            this.pendingValidations.add(uri);
            this.lastValidationTime.set(uri, Date.now());
            
            try {
                const result = await this.parser.parseFile(document.fileName);
                
                // Clear existing diagnostics
                this.diagnosticCollection.delete(document.uri);
                
                if (!result.success && result.errors?.length) {
                    const diagnostics = this.parser.parseErrorsToDiagnostics(result.errors, document);
                    this.diagnosticCollection.set(document.uri, diagnostics);
                }
            } catch (error) {
                this.diagnosticCollection.set(document.uri, [
                    new vscode.Diagnostic(
                        new vscode.Range(0, 0, 0, 1),
                        `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
                        vscode.DiagnosticSeverity.Error
                    )
                ]);
            } finally {
                this.pendingValidations.delete(uri);
            }
        };

        if (immediate) {
            await doValidation();
        } else {
            const timeout = setTimeout(doValidation, this.DEBOUNCE_TIME);
            this.validationTimeout.set(uri, timeout);
        }
    }

    clearDiagnostics(uri: vscode.Uri): void {
        const uriString = uri.toString();
        
        const timeout = this.validationTimeout.get(uriString);
        if (timeout) {
            clearTimeout(timeout);
            this.validationTimeout.delete(uriString);
        }
        
        this.pendingValidations.delete(uriString);
        this.lastValidationTime.delete(uriString);
        this.diagnosticCollection.delete(uri);
    }

    dispose(): void {
        this.diagnosticCollection.dispose();
        this.pendingValidations.clear();
        this.lastValidationTime.clear();
        
        for (const timeout of this.validationTimeout.values()) {
            clearTimeout(timeout);
        }
        this.validationTimeout.clear();
    }
}

interface DocumentSymbols {
    schemas: Set<string>;
    enums: Set<string>;
}

class TgsCompletionProvider implements vscode.CompletionItemProvider {
    private documentSymbols: Map<string, DocumentSymbols> = new Map();
    private symbolsCache: Map<string, { symbols: DocumentSymbols; timestamp: number }> = new Map();
    private readonly CACHE_TTL = 5000; // 5 seconds cache

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
        // Early return if cancelled
        if (token.isCancellationRequested) {return undefined;}
        
        await this.updateDocumentSymbols(document);
        const linePrefix = document.lineAt(position).text.substring(0, position.character);

        // Optimize pattern matching with early returns
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
        
        let varDeclMatch = linePrefix.match(/^\s*\w+\s*=\s*([^;]*)$/);
        if (varDeclMatch) {
            return this.provideVariableCompletions(document, position, varDeclMatch[1]);
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
            // Handle error silently
        }
        return items;
    }

    private async provideImportSymbolCompletions(
        document: vscode.TextDocument, position: vscode.Position, currentInput: string
    ): Promise<vscode.CompletionItem[]> {
        const line = document.lineAt(position).text;
        const pathMatch = line.match(/from\s+["']([^"']*)["']/);
        if (!pathMatch) {return [];}
        
        const importPath = pathMatch[1];
        
        try {
            const currentDir = path.dirname(document.uri.fsPath);
            const fullPath = path.resolve(currentDir, importPath);
            const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
            const content = Buffer.from(fileContent).toString('utf-8');
            const items: vscode.CompletionItem[] = [];
            
            // Use more efficient regex processing
            const schemaRegex = /create\s+schema\s+(\w+)/g;
            let match;
            while ((match = schemaRegex.exec(content)) !== null) {
                const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Class);
                item.detail = `Schema from ${path.basename(importPath)}`;
                items.push(item);
            }
            
            const enumRegex = /create\s+enum\s+(\w+)/g;
            while ((match = enumRegex.exec(content)) !== null) {
                const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Enum);
                item.detail = `Enum from ${path.basename(importPath)}`;
                items.push(item);
            }
            
            return items;
        } catch (error) {
            return [];
        }
    }

    private provideDirCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const symbols = this.documentSymbols.get(document.uri.toString());
        if (!symbols) {return [];}
        
        const items: vscode.CompletionItem[] = [];
        const content = document.getText();
        const dirRegex = /(\w+Dir)\s*=\s*([^;\n]+)/g;
        let match;
        
        while ((match = dirRegex.exec(content)) !== null) {
            const item = new vscode.CompletionItem(match[1], vscode.CompletionItemKind.Folder);
            item.detail = `Directory variable: ${match[2]}`;
            items.push(item);
        }
        
        return items;
    }

    private provideSchemaCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
        const symbols = this.documentSymbols.get(document.uri.toString());
        if (!symbols) {return [];}
        
        return Array.from(symbols.schemas).map(schema => {
            const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Class);
            item.detail = 'Schema';
            return item;
        });
    }

    private provideVariableCompletions(document: vscode.TextDocument, position: vscode.Position, typed: string): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        if (!typed || typed.startsWith('/')) {
            const item = new vscode.CompletionItem('/', vscode.CompletionItemKind.Folder);
            item.detail = 'Root path';
            items.push(item);
        }
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
        
        return keywords.map(keyword => {
            const item = new vscode.CompletionItem(keyword.label, vscode.CompletionItemKind.Keyword);
            item.detail = keyword.detail;
            if (keyword.snippet) {
                item.insertText = new vscode.SnippetString(keyword.snippet);
            }
            return item;
        });
    }

    private async updateDocumentSymbols(document: vscode.TextDocument): Promise<void> {
        const uri = document.uri.toString();
        const now = Date.now();
        
        // Check cache first
        const cached = this.symbolsCache.get(uri);
        if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
            this.documentSymbols.set(uri, cached.symbols);
            return;
        }
        
        const symbols: DocumentSymbols = { 
            schemas: new Set<string>(), 
            enums: new Set<string>() 
        };
        
        const content = document.getText();
        
        // More efficient regex processing
        const schemaRegex = /create\s+schema\s+(\w+)/g;
        let match;
        while ((match = schemaRegex.exec(content)) !== null) {
            symbols.schemas.add(match[1]);
        }
        
        const enumRegex = /create\s+enum\s+(\w+)/g;
        while ((match = enumRegex.exec(content)) !== null) {
            symbols.enums.add(match[1]);
        }
        
        // Process imports
        const importRegex = /import\s*{([^}]+)}\s*from\s*["']([^"']+)["']/g;
        while ((match = importRegex.exec(content)) !== null) {
            const importedSymbols = match[1].split(',').map(s => s.trim());
            const importPath = match[2];
            
            try {
                const currentDir = path.dirname(document.uri.fsPath);
                const fullPath = path.resolve(currentDir, importPath);
                const fileContent = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
                const importedContent = Buffer.from(fileContent).toString('utf-8');
                
                const importedSchemaRegex = /create\s+schema\s+(\w+)/g;
                let importedMatch;
                while ((importedMatch = importedSchemaRegex.exec(importedContent)) !== null) {
                    if (importedSymbols.includes(importedMatch[1])) {
                        symbols.schemas.add(importedMatch[1]);
                    }
                }
                
                const importedEnumRegex = /create\s+enum\s+(\w+)/g;
                while ((importedMatch = importedEnumRegex.exec(importedContent)) !== null) {
                    if (importedSymbols.includes(importedMatch[1])) {
                        symbols.enums.add(importedMatch[1]);
                    }
                }
            } catch (error) {
                continue;
            }
        }
        
        // Update cache and current symbols
        this.symbolsCache.set(uri, { symbols, timestamp: now });
        this.documentSymbols.set(uri, symbols);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    typegenOutputChannel = vscode.window.createOutputChannel('Typegen');
    context.subscriptions.push(typegenOutputChannel);

    const parser = new TgsParser(typegenOutputChannel);
    context.subscriptions.push(parser);

    try {
        await parser.initialize();
        typegenOutputChannel.appendLine('✅ Typegen extension activated');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        typegenOutputChannel.appendLine(`❌ Failed to connect to Typegen daemon: ${errorMessage}`);
        typegenOutputChannel.show();
        return;
    }

    const diagnosticProvider = new TgsDiagnosticProvider(context, typegenOutputChannel, parser);
    
    // Optimized event listeners with better debouncing
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            if (document.languageId === 'tgs') {
                diagnosticProvider.validateDocument(document, true);
            }
        }),
        
        // More intelligent change detection
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'tgs' && event.contentChanges.length > 0) {
                // Only validate if changes are substantial
                const hasSubstantialChanges = event.contentChanges.some(change => 
                    change.text.length > 1 || change.rangeLength > 1
                );
                if (hasSubstantialChanges) {
                    diagnosticProvider.validateDocument(event.document);
                }
            }
        }),
        
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'tgs') {
                diagnosticProvider.validateDocument(document, true);
            }
        }),
        
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document.languageId === 'tgs') {
                diagnosticProvider.clearDiagnostics(document.uri);
            }
        })
    );

    // Validate currently open .tgs files with staggered timing to avoid overwhelming the daemon
    const openDocuments = vscode.workspace.textDocuments.filter(doc => doc.languageId === 'tgs');
    for (let i = 0; i < openDocuments.length; i++) {
        setTimeout(() => {
            diagnosticProvider.validateDocument(openDocuments[i], true);
        }, i * 50); // Stagger by 50ms
    }

    const completionProvider = new TgsCompletionProvider();
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            { language: 'tgs', scheme: 'file' },
            completionProvider,
            ':', '<', '&', ' ', '=', '{', '"', "'"
        )
    );

    const showOutputCommand = vscode.commands.registerCommand('typegen.showOutput', () => {
        typegenOutputChannel.show();
    });
    context.subscriptions.push(showOutputCommand);

    // Also register a command to restart the daemon if needed
    const restartDaemonCommand = vscode.commands.registerCommand('typegen.restartDaemon', async () => {
        typegenOutputChannel.appendLine('🔄 Restarting Typegen daemon...');
        parser.dispose();
        try {
            await parser.initialize();
            typegenOutputChannel.appendLine('✅ Daemon restarted successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            typegenOutputChannel.appendLine(`❌ Failed to restart daemon: ${errorMessage}`);
            typegenOutputChannel.show();
        }
    });
    context.subscriptions.push(restartDaemonCommand);
}
