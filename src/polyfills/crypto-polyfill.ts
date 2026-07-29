if (typeof globalThis.Headers === 'undefined') {
  class HeadersPolyfill {
    private _headers: Map<string, string> = new Map();

    constructor(init?: Record<string, string> | [string, string][] | Headers) {
      if (init) {
        if (Array.isArray(init)) {
          for (const [k, v] of init) {
            this._headers.set(k.toLowerCase(), v);
          }
        } else if (typeof (init as Headers).forEach === 'function') {
          (init as Headers).forEach((v: string, k: string) => {
            this._headers.set(k.toLowerCase(), v);
          });
        } else {
          for (const [k, v] of Object.entries(init as Record<string, string>)) {
            this._headers.set(k.toLowerCase(), v);
          }
        }
      }
    }

    append(name: string, value: string): void {
      this._headers.set(name.toLowerCase(), value);
    }
    delete(name: string): void {
      this._headers.delete(name.toLowerCase());
    }
    get(name: string): string | null {
      return this._headers.get(name.toLowerCase()) ?? null;
    }
    has(name: string): boolean {
      return this._headers.has(name.toLowerCase());
    }
    set(name: string, value: string): void {
      this._headers.set(name.toLowerCase(), value);
    }
    forEach(callbackfn: (value: string, key: string, parent: Headers) => void): void {
      this._headers.forEach((v, k) => callbackfn(v, k, this as unknown as Headers));
    }
    entries(): IterableIterator<[string, string]> {
      return this._headers.entries();
    }
    keys(): IterableIterator<string> {
      return this._headers.keys();
    }
    values(): IterableIterator<string> {
      return this._headers.values();
    }
  }

  (globalThis as any).Headers = HeadersPolyfill;
}

if (typeof globalThis.Blob === 'undefined') {
  const { Blob } = require('buffer');
  (globalThis as any).Blob = Blob;
}
