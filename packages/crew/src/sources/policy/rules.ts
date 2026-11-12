const DIALECT_RULES: Record<'postgres' | 'mysql' | 'sqlite', string[]> = {
  postgres: [
    'Name every table with its schema, exactly as listed (schema.table).',
    "Use built-in functions and operators only. Compare an enum column with a plain string literal (status = 'open'); never cast to a type from the source's own schemas.",
  ],
  mysql: ['Name tables as listed (database.table, or the table alone).', 'Use built-in functions only; no stored functions, no variables.'],
  sqlite: ['Name tables as listed, unqualified.', 'Use built-in functions only.'],
};

const VIEW_RULE = 'A view is readable only if a person allowed it by name: read only the relations the structure lists; any other view is refused.';

/** The read rules an agent follows for this dialect. */
export function readRules(dialect: 'postgres' | 'mysql' | 'sqlite'): string[] {
  return [
    ...DIALECT_RULES[dialect],
    VIEW_RULE,
    ...(dialect === 'sqlite' ? [
      "No WITH clause (CTE) that reads a table: SQLite's read policy refuses any read made through a CTE. Write it as a subquery in FROM instead: SELECT ... FROM (SELECT ... FROM t) AS x.",
      'Placeholders are ? only, in declaration order.',
    ] : []),
  ];
}
