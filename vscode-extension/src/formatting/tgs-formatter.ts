import * as vscode from 'vscode';

export class TgsFormatter implements vscode.DocumentFormattingEditProvider {
    provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        options: vscode.FormattingOptions,
        token: vscode.CancellationToken
    ): vscode.TextEdit[] {
        if (token.isCancellationRequested) {
            return [];
        }

        const text = document.getText();
        const formattedText = this.formatTgsContent(text);
        
        if (formattedText === text) {
            return [];
        }

        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(text.length)
        );

        return [vscode.TextEdit.replace(fullRange, formattedText)];
    }

    private formatTgsContent(content: string): string {
        const lines = content.split('\n');
        const formattedLines: string[] = [];
        let indentLevel = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines
            if (line === '') {
                formattedLines.push('');
                continue;
            }

            // Handle closing parentheses/braces - decrease indent before formatting
            if (line.startsWith(');') || line.startsWith('}')) {
                indentLevel = Math.max(0, indentLevel - 1);
            }

            // Check if this line contains a create statement with a field on the same line
            if ((line.startsWith('create schema') || line.startsWith('create enum')) && line.includes('(') && !line.endsWith('(')) {
                // Split the create statement and the field
                const parenIndex = line.indexOf('(');
                const createPart = line.substring(0, parenIndex + 1);
                const fieldsPart = line.substring(parenIndex + 1);
                
                // Format the create statement
                const formattedCreate = this.formatLine(createPart, indentLevel);
                formattedLines.push(formattedCreate);
                
                // Increase indent for the fields
                indentLevel++;
                
                // Handle multiple fields on the same line
                if (fieldsPart.trim()) {
                    // Check if the line ends with closing parenthesis
                    let hasClosing = false;
                    let fieldsText = fieldsPart;
                    
                    if (fieldsPart.includes(');')) {
                        hasClosing = true;
                        fieldsText = fieldsPart.replace(');', '');
                    }
                    
                    // Split fields by semicolon
                    const fields = fieldsText.split(';').filter(field => field.trim());
                    
                    // Format each field
                    for (const field of fields) {
                        if (field.trim()) {
                            const formattedField = this.formatLine(field.trim() + ';', indentLevel);
                            formattedLines.push(formattedField);
                        }
                    }
                    
                    // Handle closing parenthesis if present
                    if (hasClosing) {
                        indentLevel = Math.max(0, indentLevel - 1);
                        formattedLines.push('\t'.repeat(indentLevel) + ');');
                    }
                }
            } else {
                let formattedLine = this.formatLine(line, indentLevel);
                formattedLines.push(formattedLine);

                // Handle opening parentheses/braces - increase indent after formatting
                if (line.includes('(') && !line.includes(');')) {
                    indentLevel++;
                }
            }
        }

        // Remove trailing empty lines and ensure single newline at end
        while (formattedLines.length > 0 && formattedLines[formattedLines.length - 1].trim() === '') {
            formattedLines.pop();
        }

        return formattedLines.join('\n') + (formattedLines.length > 0 ? '\n' : '');
    }

    private formatLine(line: string, indentLevel: number): string {
        const indent = '\t'.repeat(indentLevel); // Tab per indent level

        // Variable assignment (e.g., "demandsDir = /Demands;")
        if (line.includes('=') && !line.includes('create')) {
            return indent + this.formatVariableAssignment(line);
        }

        // Create schema/enum statements (without fields on same line)
        if ((line.startsWith('create schema') || line.startsWith('create enum')) && line.endsWith('(')) {
            return indent + this.formatCreateStatement(line);
        }

        // Schema/enum field definitions (e.g., "DemandedMachine: string;")
        if (line.includes(':') && (line.endsWith(';') || line.endsWith('?;'))) {
            return indent + this.formatFieldDefinition(line);
        }

        // Import statements
        if (line.startsWith('import')) {
            return indent + this.formatImportStatement(line);
        }

        // Closing statements
        if (line === ');' || line === '}') {
            return indent + line;
        }

        // Default: just apply indent and preserve content
        return indent + line;
    }

    private formatVariableAssignment(line: string): string {
        // Handle variable assignments like "demandsDir = /Demands;" or "responsesDir = demandsDir + /Responses;"
        const parts = line.split('=');
        if (parts.length !== 2) {
            return line;
        }

        const varName = parts[0].trim();
        let value = parts[1].trim();

        // Format path expressions with + operator
        if (value.includes('+')) {
            value = value.replace(/\s*\+\s*/g, ' + ');
        }

        return `${varName} = ${value}`;
    }

    private formatCreateStatement(line: string): string {
        // Handle case where line ends with just opening parenthesis
        if (line.endsWith('(')) {
            const match = line.match(/^(create\s+(?:schema|enum))\s+(\w+)\s*<([^>]+)>\s*\($/);
            if (match) {
                const [, createType, name, dir] = match;
                return `${createType} ${name}<${dir}>(`;
            }
        }
        
        // Format "create schema Name<dir>(" or "create enum Name<dir>("
        const match = line.match(/^(create\s+(?:schema|enum))\s+(\w+)\s*<([^>]+)>\s*\(/);
        if (match) {
            const [, createType, name, dir] = match;
            return `${createType} ${name}<${dir}>(`;
        }
        return line;
    }

    private formatFieldDefinition(line: string): string {
        // Format field definitions like "DemandedMachine: string;" or "RequestedByCustomerId: Uid?;"
        const semicolonIndex = line.lastIndexOf(';');
        if (semicolonIndex === -1) {
            return line;
        }

        const fieldPart = line.substring(0, semicolonIndex).trim();
        const colonIndex = fieldPart.indexOf(':');
        
        if (colonIndex === -1) {
            return line;
        }

        const fieldName = fieldPart.substring(0, colonIndex).trim();
        const fieldType = fieldPart.substring(colonIndex + 1).trim();

        return `${fieldName}: ${fieldType};`;
    }

    private formatImportStatement(line: string): string {
        // Format import statements like "import { Schema1, Schema2 } from "path";"
        const match = line.match(/^import\s*{\s*([^}]+)\s*}\s*from\s*["']([^"']+)["']\s*;?$/);
        if (match) {
            const [, imports, path] = match;
            const cleanImports = imports.split(',').map(imp => imp.trim()).join(', ');
            return `import { ${cleanImports} } from "${path}";`;
        }
        return line;
    }
} 