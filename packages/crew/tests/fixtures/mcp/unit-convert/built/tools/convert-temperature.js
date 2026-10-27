// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 the unit-convert authors
import { UserError } from "fastmcp";
import { defineTool } from "./registry.js";
import { annotations, parameters, result, validate } from "./conversion.js";
const boundaries = { C: -273.15, F: -459.67, K: 0 };
export function registerTemperature(server, config) {
    defineTool(server, config, {
        name: "convert_temperature",
        description: "Convert a finite temperature among C, F, K. Temperatures below absolute zero are rejected.",
        parameters: parameters("C, F, K"),
        annotations,
        execute: async ({ value, from, to }) => {
            validate(value, from, to, Object.keys(boundaries));
            if (value < boundaries[from])
                throw new UserError("Temperature is below absolute zero");
            const kelvin = from === "C" ? value + 273.15 : from === "F" ? (value + 459.67) * (5 / 9) : value;
            // Direct C/F affine forms avoid Kelvin cancellation at 32 F -> 0 C.
            const converted = from === to ? value
                : from === "F" && to === "C" ? (value - 32) * (5 / 9)
                    : from === "C" && to === "F" ? value * (9 / 5) + 32
                        : to === "C" ? kelvin - 273.15
                            : to === "F" ? (kelvin - 273.15) * (9 / 5) + 32 : kelvin;
            return result(value, from, to, converted);
        },
    });
}
//# sourceMappingURL=convert-temperature.js.map