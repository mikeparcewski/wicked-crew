import type { FastifyInstance } from 'fastify';

/** Shared request parsing, including fixed errors that never disclose body content. */
export function registerJsonParser(app: FastifyInstance): void {
  // Tolerate an empty body on application/json POSTs (some actions take no body).
  // Default Fastify v5 rejects "" with FST_ERR_CTP_EMPTY_JSON_BODY.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body === undefined || body === null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      // A syntactically invalid body is the CLIENT's error: without an explicit statusCode
      // Fastify reports a parser error as a 500, which misfiles "you sent `{not json`" as a
      // server fault — on the elicitation answer path that told an operator the daemon broke
      // when their request did. 400 matches Fastify's own default JSON parser
      // (FST_ERR_CTP_INVALID_JSON) and every schema-level 400 these routes already return.
      // The message is a fixed one, never JSON.parse's: V8 quotes the body around the bad token
      // (`Unexpected token 's', ..."{"value": sk-…"... is not valid JSON`), and Fastify both
      // answers and logs it, so an unquoted `PUT /mcp/servers/:name/secret` value would leave the
      // broker in the response and the log (DES-MCP-TOOLS-001 D-2).
      done(Object.assign(new Error('the request body is not valid JSON'), { statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON' }));
    }
  });
}
