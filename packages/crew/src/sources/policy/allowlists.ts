/**
 * The closed allowlists of the SQL read policy (DES-APPS-001 §5.3 rules 2-4). One place, used by the
 * Postgres and MySQL checks and by the SQLite authorizer. A name is allowed only when it is listed
 * here AND not caught by the deny list, which names the dangerous families again on purpose (a later
 * edit that adds one to an allowlist still fails closed).
 */

/** Postgres functions a read may call (aggregates, window, arithmetic, string, date/time, json). */
export const PG_FUNCTIONS: ReadonlySet<string> = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg',
  'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'percentile_cont',
  'percentile_disc', 'mode', 'json_agg', 'jsonb_agg', 'json_object_agg', 'jsonb_object_agg', 'corr',
  'covar_pop', 'covar_samp',
  // window
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value',
  'last_value', 'nth_value',
  // arithmetic
  'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'sign', 'sqrt', 'cbrt', 'power', 'pow', 'exp', 'ln',
  'log', 'log10', 'mod', 'div', 'width_bucket', 'pi', 'degrees', 'radians',
  // string
  'lower', 'upper', 'length', 'char_length', 'character_length', 'octet_length', 'concat', 'concat_ws',
  'substr', 'substring', 'left', 'right', 'lpad', 'rpad', 'ltrim', 'rtrim', 'btrim', 'replace',
  'split_part', 'strpos', 'position', 'initcap', 'reverse', 'md5', 'starts_with', 'to_hex', 'translate',
  'overlay', 'ascii', 'chr',
  // date and time (EXTRACT, AT TIME ZONE and the SQL value functions parse to these)
  'date_trunc', 'date_part', 'extract', 'now', 'age', 'make_date', 'make_time', 'make_timestamp',
  'make_timestamptz', 'make_interval', 'date_bin', 'to_char', 'to_date', 'to_timestamp', 'to_number',
  'justify_days', 'justify_hours', 'justify_interval', 'isfinite', 'timezone', 'clock_timestamp',
  'statement_timestamp', 'transaction_timestamp',
  // json (structure accessors; the -> ->> #> #>> operators are in PG_OPERATORS)
  'json_build_object', 'jsonb_build_object', 'json_build_array', 'jsonb_build_array', 'json_extract_path',
  'json_extract_path_text', 'jsonb_extract_path', 'jsonb_extract_path_text', 'json_array_length',
  'jsonb_array_length', 'json_typeof', 'jsonb_typeof', 'to_json', 'to_jsonb',
  // null handling
  'num_nulls', 'num_nonnulls',
]);

/** Operator symbols a read may use: comparison, arithmetic, concatenation, LIKE and json access. */
export const PG_OPERATORS: ReadonlySet<string> = new Set([
  '=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^', '||',
  '~~', '!~~', '~~*', '!~~*', // [NOT] [I]LIKE
  '->', '->>', '#>', '#>>', '@>', '<@', '?', '?|', '?&',
]);

/**
 * Types a read may cast to (§5.3 rule 4: scalar types). `interval` and `time` are scalar and side
 * effect free, and dashboards need `now() - interval '7 days'`. Never a `reg*` type, an array, a
 * domain or any type outside `pg_catalog`.
 */
export const PG_CAST_TYPES: ReadonlySet<string> = new Set([
  'int2', 'int4', 'int8', 'smallint', 'integer', 'int', 'bigint', 'numeric', 'decimal', 'float4', 'float8',
  'real', 'text', 'varchar', 'bool', 'boolean', 'date', 'timestamp', 'timestamptz', 'time', 'interval', 'uuid',
  'json', 'jsonb',
]);

/** The column types a declared row write may write or key on (DES §7.4: exact base conversion, equality). */
export const PG_WRITABLE_TYPES: ReadonlySet<string> = new Set([
  'int2', 'int4', 'int8', 'numeric', 'text', 'varchar', 'bool', 'date', 'timestamp', 'timestamptz', 'uuid', 'jsonb',
]);

/** MySQL functions a read may call (upper case, as the grammar normalizes them). */
export const MYSQL_FUNCTIONS: ReadonlySet<string> = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STD', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE',
  'VAR_POP', 'VAR_SAMP', 'JSON_ARRAYAGG', 'JSON_OBJECTAGG',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE',
  'LAST_VALUE', 'NTH_VALUE',
  'ABS', 'CEIL', 'CEILING', 'FLOOR', 'ROUND', 'TRUNCATE', 'SIGN', 'SQRT', 'POW', 'POWER', 'EXP', 'LN', 'LOG',
  'LOG10', 'LOG2', 'MOD', 'PI', 'GREATEST', 'LEAST',
  'LOWER', 'UPPER', 'LCASE', 'UCASE', 'LENGTH', 'CHAR_LENGTH', 'CHARACTER_LENGTH', 'CONCAT', 'CONCAT_WS',
  'SUBSTR', 'SUBSTRING', 'LEFT', 'RIGHT', 'LPAD', 'RPAD', 'LTRIM', 'RTRIM', 'TRIM', 'REPLACE',
  'SUBSTRING_INDEX', 'LOCATE', 'INSTR', 'POSITION', 'REVERSE', 'FORMAT',
  'NOW', 'CURDATE', 'CURRENT_DATE', 'CURTIME', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'UTC_DATE', 'UTC_TIMESTAMP',
  'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'DAYOFMONTH', 'DAYOFWEEK', 'DAYOFYEAR', 'WEEK', 'WEEKDAY', 'QUARTER',
  'HOUR', 'MINUTE', 'SECOND', 'DATE_FORMAT', 'DATE_ADD', 'DATE_SUB', 'ADDDATE', 'SUBDATE', 'DATEDIFF',
  'TIMESTAMPDIFF', 'TIMESTAMPADD', 'LAST_DAY', 'MAKEDATE', 'STR_TO_DATE', 'UNIX_TIMESTAMP', 'FROM_UNIXTIME',
  'EXTRACT',
  'IF', 'IFNULL', 'NULLIF', 'COALESCE',
  'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_LENGTH', 'JSON_TYPE',
]);

/** MySQL CAST targets (scalar). */
export const MYSQL_CAST_TYPES: ReadonlySet<string> = new Set(['SIGNED', 'UNSIGNED', 'DECIMAL', 'CHAR', 'DATE', 'DATETIME', 'TIME', 'DOUBLE', 'FLOAT', 'JSON']);

/** SQLite functions the authorizer allows (lower case, as SQLite reports them). */
export const SQLITE_FUNCTIONS: ReadonlySet<string> = new Set([
  'count', 'sum', 'total', 'avg', 'min', 'max', 'group_concat', 'string_agg',
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value',
  'last_value', 'nth_value',
  'abs', 'round', 'ceil', 'ceiling', 'floor', 'trunc', 'sign', 'sqrt', 'power', 'pow', 'exp', 'ln', 'log',
  'log10', 'log2', 'mod', 'pi',
  'lower', 'upper', 'length', 'substr', 'substring', 'trim', 'ltrim', 'rtrim', 'replace', 'instr', 'printf',
  'format', 'coalesce', 'ifnull', 'nullif', 'iif', 'typeof', 'cast',
  'date', 'time', 'datetime', 'julianday', 'unixepoch', 'strftime',
  'json_extract', 'json_array_length', 'json_type',
]);

/**
 * Denied by name in every dialect, whatever the allowlists say (§5.3 rule 4): functions that execute
 * a string as SQL, read files, sleep, lock, reach another database or large objects, or change settings.
 */
export function deniedFunction(name: string): boolean {
  const n = name.toLowerCase();
  if (/^(pg_|lo_|dblink|xml|query_to|table_to|cursor_to|schema_to|database_to|txid_|set_config|current_setting)/.test(n)) return true;
  return new Set([
    'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks', 'is_free_lock', 'is_used_lock', 'load_file',
    'master_pos_wait', 'source_pos_wait', 'wait_for_executed_gtid_set', 'nextval', 'setval', 'currval',
    'generate_series', 'unnest', 'load_extension', 'readfile', 'writefile', 'edit', 'fts3_tokenizer',
  ]).has(n);
}
