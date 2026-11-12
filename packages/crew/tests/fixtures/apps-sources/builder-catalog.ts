import type { CatalogRelation, SqlCatalog } from '../../../src/sources/catalog/types.js';

/** A catalog whose work tables fall past the old detail cut. */
export function builderCatalog(dialect: SqlCatalog['dialect'] = 'postgres'): SqlCatalog {
  const database = dialect === 'mysql' ? 'connection_database' : null;
  const relation = (schema: string, name: string): CatalogRelation => ({
    schema: database ?? schema,
    name,
    kind: 'table',
    rowEstimate: 100,
    columns: [
      { name: 'id', type: 'bigint', nullable: false },
      ...Array.from({ length: 30 }, (_, i) => ({ name: `field_${i}`, type: 'text', nullable: true })),
    ],
    primaryKey: ['id'],
    foreignKeys: [],
  });
  const cases = relation('work', 'cases');
  cases.columns.push({ name: 'assignee', type: 'text', nullable: true }, { name: 'status', type: 'text', nullable: false, enumValues: ['open', 'closed'] });
  const events = relation('work', 'case_events');
  events.columns.push({ name: 'case_id', type: 'bigint', nullable: false });
  events.foreignKeys.push({ name: 'case_events_case_fk', columns: ['case_id'], references: { schema: database ?? 'work', table: 'cases', columns: ['id'] } });
  return {
    dialect,
    database,
    describedAt: '2026-11-04T03:00:12.000Z',
    relations: [
      ...Array.from({ length: 50 }, (_, i) => relation('public', `table_${i}`)),
      cases,
      events,
      ...Array.from({ length: 27 }, (_, i) => relation('work', `record_${i}`)),
    ],
  };
}
