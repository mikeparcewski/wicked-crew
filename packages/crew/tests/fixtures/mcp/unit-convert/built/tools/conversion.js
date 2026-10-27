// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 the unit-convert authors
import { UserError } from "fastmcp";
import { z } from "zod";
export const annotations = {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};
export const parameters = (units) => z.object({
    value: z.number().describe("Finite input value"),
    from: z.string().describe(`Source unit: ${units}`),
    to: z.string().describe(`Target unit: ${units}`),
});
export function validate(value, from, to, units) {
    if (!units.includes(from) || !units.includes(to)) {
        throw new UserError(`Unknown unit. Allowed units: ${units.join(", ")}`);
    }
    if (!Number.isFinite(value))
        throw new UserError("Input value must be finite");
}
export function result(input, from, to, converted) {
    if (!Number.isFinite(converted))
        throw new UserError("Converted result must be finite");
    const value = Number(converted.toPrecision(12)) || 0;
    // fastmcp's content result is used for text; structuredContent carries the numeric value.
    return {
        content: [{ type: "text", text: `${input || 0} ${from} = ${value} ${to}` }],
        structuredContent: { value },
    };
}
//# sourceMappingURL=conversion.js.map