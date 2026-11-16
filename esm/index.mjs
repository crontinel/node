// ESM entry: the build is CommonJS, so re-export it with a real default export.
import cjs from '../dist/index.js';

export const { Crontinel } = cjs;
export default cjs.Crontinel;
