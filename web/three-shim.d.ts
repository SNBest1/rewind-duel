// three.js ships without TypeScript types and @types/three is not installed here, so the module is typed loosely.
// Only web/view3d.ts imports it, and everything it hands back to main.ts is typed by view3d.ts itself.
declare module 'three';
