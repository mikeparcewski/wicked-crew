let stdioTrusted = false;
export function configureAuth(config) {
    stdioTrusted = config.transport === "stdio" && config.auth.scheme === "none";
}
export function requireSession(session) {
    void session;
    return stdioTrusted;
}
//# sourceMappingURL=auth.js.map