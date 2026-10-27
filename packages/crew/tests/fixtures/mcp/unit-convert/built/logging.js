// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 the unit-convert authors
import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import { format } from "node:util";
import { openTelemetryPlugin } from "@loglayer/plugin-opentelemetry";
import { redactionPlugin } from "@loglayer/plugin-redaction";
import { OpenTelemetryTransport } from "@loglayer/transport-opentelemetry";
import { ConsoleTransport, LogLayer } from "loglayer";
const REDACT_ALWAYS = ["authorization", "token", "secret", "password", "client_secret"];
/**
 * stdout carries MCP protocol frames only: the console transport writes to stderr.
 */
const stderrConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
function build(secretNames) {
    return new LogLayer({
        plugins: [openTelemetryPlugin(), redactionPlugin({ paths: [...secretNames, ...REDACT_ALWAYS] })],
        transport: [new OpenTelemetryTransport({}), new ConsoleTransport({ logger: stderrConsole })],
    });
}
let root = build([]);
const als = new AsyncLocalStorage();
/** Build the root logger once the secret variable's name is known (it is redacted by name). */
export function initLogging(secretNames) {
    root = build(secretNames);
    return root;
}
export function rootLogger() {
    return root;
}
/** The request-scoped logger when inside a tool call, else the root. */
export function getLogger() {
    return als.getStore()?.logger ?? root;
}
export function runWithLogger(child, fn) {
    return als.run({ logger: child }, fn);
}
/** fastmcp's Logger (debug/error/info/log/warn) adapted onto the root logger. */
export function fastmcpLogger(logger = root) {
    const line = (args) => format(...args);
    return {
        debug: (...args) => logger.debug(line(args)),
        error: (...args) => logger.error(line(args)),
        info: (...args) => logger.info(line(args)),
        log: (...args) => logger.info(line(args)),
        warn: (...args) => logger.warn(line(args)),
    };
}
//# sourceMappingURL=logging.js.map