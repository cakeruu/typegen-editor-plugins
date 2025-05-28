// Constants for TGS types
export const TGS_TYPES = [
    'Uid', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
    'byte', 'sbyte', 'float', 'double', 'decimal', 'bool',
    'char', 'object', 'string', 'Array', 'List', 'Map',
    'Set', 'Queue', 'Date', 'DateTime'
] as const;

export type TGSType = typeof TGS_TYPES[number]; 