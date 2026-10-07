// Vite `define` constant from vite.config.ts: the arbiter origin the dev
// proxy targets, or null in a production build (there the arbiter serves
// the app itself, so location.origin IS the arbiter's origin).
declare const __IDLEFILL_DEV_API__: string | null;
