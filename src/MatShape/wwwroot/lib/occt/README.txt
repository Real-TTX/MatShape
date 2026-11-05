occt-import-js 0.0.23 (LGPL-2.1, OpenCascade: LGPL-2.1 with exception), copied unchanged from the npm package "occt-import-js" (dist/occt-import-js.js,
dist/occt-import-js.wasm, dist/occt-import-js-worker.js, the two license files).
It runs in a Web Worker. Its code builds functions at run time (embind, new Function): the worker needs a Content-Security-Policy with 'unsafe-eval'
for /lib/occt, which MatShape does not give (yet) – without it STEP/IGES/BREP cannot be read; STL and the STEP export need no library. It reads STEP, IGES and BREP files in the browser (MatShape loads it only when such a file is imported).
Do not edit. Update: npm pack occt-import-js, copy the dist files.
