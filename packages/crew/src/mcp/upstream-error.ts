/**
 * Why an upstream call failed (DES-MCP-TOOLS-001 §6 steps 6-7). Its own module so the MCP invoker
 * (`invoke.ts`) and the REST invoker (`rest.ts`) share it without importing each other at load.
 */

/** Why an upstream call failed. `boundary` = a `rest` request would have left its pinned host (I6). */
export type UpstreamErrorClass = 'transport' | 'timeout' | 'http' | 'protocol' | 'boundary';

export class UpstreamCallError extends Error {
  constructor(
    readonly errorClass: UpstreamErrorClass,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
  }
}
