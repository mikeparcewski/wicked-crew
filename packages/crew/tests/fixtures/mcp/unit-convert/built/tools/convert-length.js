import { defineTool } from "./registry.js";
import { annotations, parameters, result, validate } from "./conversion.js";
const factors = {
    mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344,
};
export function registerLength(server, config) {
    defineTool(server, config, {
        name: "convert_length",
        description: "Convert a finite length among mm, cm, m, km, in, ft, yd, mi. Negative lengths are accepted.",
        parameters: parameters(Object.keys(factors).join(", ")),
        annotations,
        execute: async ({ value, from, to }) => {
            validate(value, from, to, Object.keys(factors));
            return result(value, from, to, value * (factors[from] / factors[to]));
        },
    });
}
//# sourceMappingURL=convert-length.js.map