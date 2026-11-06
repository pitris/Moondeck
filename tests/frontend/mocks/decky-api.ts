/* Mock of @decky/api: `callable` routes to a programmable fake backend. */
type Handler = (...args: any[]) => any;

export const backend: Record<string, Handler> = {};
export const calls: { route: string; args: unknown[] }[] = [];
export const toasts: unknown[] = [];

export const callable = (route: string) => async (...args: unknown[]) => {
  calls.push({ route, args });
  const h = backend[route];
  if (!h) return { ok: true };
  return h(...args);
};

const listeners: Record<string, Set<Handler>> = {};
export const addEventListener = (event: string, l: Handler) => {
  (listeners[event] ??= new Set()).add(l);
  return l;
};
export const removeEventListener = (event: string, l: Handler) => listeners[event]?.delete(l);
export const toaster = { toast: (t: unknown) => { toasts.push(t); return { data: t, dismiss() {} }; } };

const patches: Record<string, Handler[]> = {};
export const routerHook = {
  routes: {} as Record<string, unknown>,
  addPatch(path: string, p: Handler) { (patches[path] ??= []).push(p); return p; },
  removePatch(path: string, p: Handler) { patches[path] = (patches[path] ?? []).filter((x) => x !== p); },
  addRoute(path: string, c: unknown) { this.routes[path] = c; },
  removeRoute(path: string) { delete this.routes[path]; },
  patchesFor: (path: string) => patches[path] ?? [],
};
export const definePlugin = (fn: () => unknown) => fn;
