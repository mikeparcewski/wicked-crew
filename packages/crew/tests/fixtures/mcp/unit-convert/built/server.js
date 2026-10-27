// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 the unit-convert authors
import { FastMCP } from "fastmcp";
import { configureAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { fastmcpLogger, initLogging } from "./logging.js";
import { startTelemetry, stopTelemetry } from "./telemetry.js";
import { registerLength } from "./tools/convert-length.js";
import { registerTemperature } from "./tools/convert-temperature.js";
async function main() {
    const config = loadConfig();
    await startTelemetry(config.key);
    const root = initLogging([]);
    configureAuth(config);
    const server = new FastMCP({
        name: config.key,
        version: config.version,
        instructions: "Local length and temperature conversion. No credential required.",
        logger: fastmcpLogger(root),
    });
    registerLength(server, config);
    registerTemperature(server, config);
    root.withMetadata({ transport: config.transport, tools: 2 }).info("starting");
    const stop = async () => {
        await server.stop().catch(() => undefined);
        await stopTelemetry();
        process.exit(0);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    await server.start({ transportType: "stdio" });
}
main().catch(async (err) => {
    process.stderr.write(`unit-convert: ${err instanceof Error ? err.message : String(err)}\n`);
    await stopTelemetry();
    process.exit(1);
});
//# sourceMappingURL=server.js.map