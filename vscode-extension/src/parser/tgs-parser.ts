import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ParseResult } from './types';

export class TgsParser implements vscode.Disposable {
    private parserPath: string = 'typegen';
    private outputChannel!: vscode.OutputChannel;
    private daemonProcess: ChildProcess | null = null;
    private isDaemonReady: boolean = false;
    private stdoutBuffer: string = '';
    private static instance: TgsParser | null = null;
    private initializationPromise: Promise<void> | null = null;
    private currentRequest: { filePath: string; resolve: Function; reject: Function } | null = null;
    
    constructor(outputChannel: vscode.OutputChannel) {
        this.outputChannel = outputChannel;
        
        if (TgsParser.instance) {
            return TgsParser.instance;
        }
        
        TgsParser.instance = this;
        return this;
    }

    public initialize(): Promise<void> {
        this.outputChannel.appendLine('🚀 Initializing Typegen daemon...');
        
        if (this.isDaemonReady && this.daemonProcess) {
            this.outputChannel.appendLine('✅ Daemon already ready');
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

            this.outputChannel.appendLine(`🚀 Starting Typegen daemon: ${this.parserPath} parse --json --daemon`);
            
            try {
                this.daemonProcess = spawn(this.parserPath, ['parse', '--json', '--daemon'], { 
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: false,
                    shell: process.platform === 'win32'
                });
            } catch (spawnError) {
                this.outputChannel.appendLine(`❌ Failed to spawn daemon: ${spawnError}`);
                rejectInitialize(new Error(`Failed to spawn: ${spawnError}`));
                return;
            }

            if (!this.daemonProcess) {
                const errorMsg = 'Failed to spawn Typegen daemon process.';
                this.outputChannel.appendLine(`❌ ${errorMsg}`);
                this.rejectAllPending(new Error(errorMsg));
                rejectInitialize(new Error(errorMsg));
                return;
            }

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
            }, 10000);

            this.daemonProcess.on('error', (err: NodeJS.ErrnoException) => {
                clearTimeout(startupTimeout);
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

            this.daemonProcess.on('close', (code, signal) => {
                clearTimeout(startupTimeout);
                this.isDaemonReady = false;
                this.daemonProcess = null;
                const errorMsg = `Daemon process closed (code: ${code}, signal: ${signal})`;
                this.outputChannel.appendLine(`❌ ${errorMsg}`);
                this.rejectAllPending(new Error(errorMsg));
                if (!this.isDaemonReady) {
                    rejectInitialize(new Error(errorMsg));
                }
                this.initializationPromise = null;
            });

            if (this.daemonProcess.stderr) {
                this.daemonProcess.stderr.setEncoding('utf8');
                this.daemonProcess.stderr.on('data', (data) => {
                    const errorText = data.toString().trim();
                    if (errorText.includes('error') || errorText.includes('Error')) {
                        this.outputChannel.appendLine(`🔴 STDERR: ${errorText}`);
                    }
                });
            }

            if (this.daemonProcess.stdout) {
                this.daemonProcess.stdout.setEncoding('utf8');
                this.daemonProcess.stdout.on('data', (data: string) => {
                    this.stdoutBuffer += data;
                    // Only process if we have complete lines
                    if (data.includes('\n')) {
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

    private isProcessingBuffer = false;
    
    private processStdoutBuffer(resolveInitialize?: () => void, rejectInitialize?: (reason?: any) => void, startupTimeout?: NodeJS.Timeout) {
        if (this.isProcessingBuffer) {
            return;
        }
        
        this.isProcessingBuffer = true;
        
        try {
            const lines = this.stdoutBuffer.split('\n');
            this.stdoutBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) {continue;}
                
                try {
                    const result = JSON.parse(line);
                    
                    if (result.status === 'ready') {
                        this.isDaemonReady = true;
                        this.outputChannel.appendLine('✅ Daemon is ready!');
                        if (startupTimeout) {
                            clearTimeout(startupTimeout);
                        }
                        if (resolveInitialize) {
                            resolveInitialize();
                            resolveInitialize = undefined;
                        }
                        continue;
                    }

                    // Handle parsing result
                    if (this.currentRequest) {
                        if (result.errors?.length) {
                            result.errors = this.processErrors(result.errors);
                        }
                        
                        this.currentRequest.resolve(result as ParseResult);
                        this.currentRequest = null;
                    }
                } catch (parseError) {
                    this.outputChannel.appendLine(`❌ Error parsing daemon response: ${parseError}`);
                    continue;
                }
            }
        } finally {
            this.isProcessingBuffer = false;
        }
    }

    private processErrors(errors: string[]): string[] {
        const replacements: Array<[RegExp, string]> = [
            [/\\u003CSPACE\\u003E/g, '<SPACE>'],
            [/\\u003C/g, '<'],
            [/\\u003E/g, '>'],
            [/\\u0027/g, "'"]
        ];

        const processedErrors = errors.map((error) => {
            let processedError = error;
            for (const [regex, replacement] of replacements) {
                processedError = processedError.replace(regex, replacement);
            }
            return processedError;
        });
        
        return processedErrors;
    }

    // Send content directly to daemon as JSON
    async parseContent(content: string, filePath: string): Promise<ParseResult> {
        if (!this.isDaemonReady || !this.daemonProcess?.stdin?.writable) {
            await this.initialize();
        }

        return new Promise((resolve, reject) => {
            // Cancel any existing request
            if (this.currentRequest) {
                this.currentRequest.reject(new Error('Request cancelled - newer request'));
            }
            
            this.currentRequest = { filePath, resolve, reject };
            
            // Send JSON with content to daemon
            const request = {
                content: content,
                file_path: filePath
            };
            
            const requestJson = JSON.stringify(request);
            
            this.daemonProcess!.stdin!.write(requestJson + '\n', (err) => {
                if (err) {
                    if (this.currentRequest && this.currentRequest.filePath === filePath) {
                        this.currentRequest.reject(new Error(`Failed to send request: ${err.message}`));
                        this.currentRequest = null;
                    }
                }
            });
        });
    }

    // Parse file - if document provided, use temp file with current content
    async parseFile(filePath: string, document?: vscode.TextDocument): Promise<ParseResult> {
        if (document) {
            // Use document content for parsing via temp file
            return this.parseContent(document.getText(), filePath);
        }
        
        // Parse actual file
        if (!this.isDaemonReady || !this.daemonProcess?.stdin?.writable) {
            await this.initialize();
        }

        return new Promise((resolve, reject) => {
            // Store the current request (daemon only handles one at a time)
            if (this.currentRequest) {
                this.currentRequest.reject(new Error('Request cancelled - newer request'));
            }
            
            this.currentRequest = { filePath, resolve, reject };
            
            this.daemonProcess!.stdin!.write(filePath + '\n', (err) => {
                if (err) {
                    if (this.currentRequest && this.currentRequest.filePath === filePath) {
                        this.currentRequest.reject(new Error(`Failed to send request: ${err.message}`));
                        this.currentRequest = null;
                    }
                }
            });
        });
    }

    private rejectAllPending(error: Error) {
        if (this.currentRequest) {
            this.currentRequest.reject(error);
            this.currentRequest = null;
        }
    }

    public dispose() {
        this.outputChannel.appendLine('🔄 Disposing Typegen daemon...');
        if (this.daemonProcess) {
            this.daemonProcess.kill();
            this.daemonProcess = null;
        }
        this.isDaemonReady = false;
        this.rejectAllPending(new Error('Typegen daemon disposed.'));
        this.initializationPromise = null;
        this.outputChannel.appendLine('✅ Daemon disposed');
    }
    
    parseErrorsToDiagnostics(errors: string[], document: vscode.TextDocument): vscode.Diagnostic[] {
        const diagnostics: vscode.Diagnostic[] = [];
        const lineCount = document.lineCount;
        
        for (let i = 0; i < errors.length; i++) {
            const error = errors[i];
            const parts = error.split('<SPACE>', 2);
            
            if (parts.length !== 2) {
                // Generic error without line number
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 1),
                    error,
                    vscode.DiagnosticSeverity.Error
                ));
                continue;
            }

            const parsedLine = parseInt(parts[0], 10);
            
            if (isNaN(parsedLine)) {
                // Line number is invalid, create generic diagnostic
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(0, 0, 0, 1),
                    error,
                    vscode.DiagnosticSeverity.Error
                ));
                continue;
            }

            // Create diagnostic for specific line
            const line = Math.max(0, Math.min(parsedLine - 1, lineCount - 1));
            const specificLine = document.lineAt(line);
            const range = new vscode.Range(
                line,
                specificLine.firstNonWhitespaceCharacterIndex,
                line,
                specificLine.text.length
            );
            
            diagnostics.push(new vscode.Diagnostic(
                range,
                parts[1],
                vscode.DiagnosticSeverity.Error
            ));
        }
        
        return diagnostics;
    }
} 