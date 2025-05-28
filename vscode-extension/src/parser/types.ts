export interface ParseResult {
    success: boolean;
    errors: string[];
    schemas?: number;
    enums?: number;
    imports?: number;
    file?: string;
} 