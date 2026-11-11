// @decky/ui's real tree helpers read Steam's React internals (window.SP_REACT) at import time.
(globalThis as any).window ??= globalThis;
(globalThis as any).window.SP_REACT ??= { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {} };
// Steam ships React's production build, where element props are mutable (Decky
// patches rely on that). React's development build freezes them, so test with
// the production build to match the device.
process.env.NODE_ENV = "production";
