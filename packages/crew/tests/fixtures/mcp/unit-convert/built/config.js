// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 the unit-convert authors
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
export const SERVER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ConfigSchema = z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    transport: z.literal("stdio"),
    auth: z.strictObject({ scheme: z.literal("none") }),
    rateLimitPerMin: z.number().int().positive(),
});
export function loadConfig(env = process.env, root = SERVER_ROOT) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(join(root, "mcp-server.config.json"), "utf8"));
    }
    catch {
        throw new Error("mcp-server.config.json: cannot read valid JSON");
    }
    if (env.MCP_TRANSPORT && env.MCP_TRANSPORT !== "stdio") {
        throw new Error("MCP_TRANSPORT: only stdio is supported");
    }
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`mcp-server.config.json: invalid field "${parsed.error.issues[0]?.path.join(".")}"`);
    }
    return parsed.data;
}
//# sourceMappingURL=config.js.map