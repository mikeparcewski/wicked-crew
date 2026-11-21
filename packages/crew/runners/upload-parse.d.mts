/** Limits are supplied by the daemon's UPLOAD_LIMITS (crew#1289). */
export interface UploadParseLimits {
  readonly expandedBytes: number;
  readonly rows: number;
  readonly columns: number;
}
export function parseCsv(text: string, limits: UploadParseLimits): string[][];
export function parseXlsx(data: Buffer, limits: UploadParseLimits): string[][];
export function detectHeader(rows: readonly string[][], choice: 'yes' | 'no' | null): boolean;
export function looksLikeHeader(first: readonly string[]): boolean;
export function columnNames(first: readonly string[], width: number, header: boolean): string[];
export function inferType(values: Iterable<string>): 'INTEGER' | 'REAL' | 'TEXT';
export function tableNameFor(filename: string): string;
