import nodeFetch from 'node-fetch';

if (typeof globalThis.Headers === 'undefined') {
  // node-fetch@2: default export is the fetch function, but it also has .Headers, .Request, .Response attached
  const nodeFetchMod = require('node-fetch');
  (globalThis as any).Headers = nodeFetchMod.Headers;
  (globalThis as any).Request = nodeFetchMod.Request;
  (globalThis as any).Response = nodeFetchMod.Response;
}

if (typeof globalThis.fetch === 'undefined') {
  (globalThis as any).fetch = nodeFetch;
}
