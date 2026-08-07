// src/polyfills.ts
import { randomBytes } from 'node:crypto';

// ✅ Properly typed polyfill for Node.js 16
if (!globalThis.crypto) {
    (globalThis as any).crypto = {
        getRandomValues: <T extends ArrayBufferView>(array: T): T => {
            // Handle different typed array types
            const bytes = randomBytes(array.byteLength);
            const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            view.set(bytes);
            return array;
        },
        randomUUID: () => {
            return randomBytes(16).toString('hex');
        },
        subtle: {} as any
    };
} else if (!globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
        const bytes = randomBytes(array.byteLength);
        const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        view.set(bytes);
        return array;
    };
}

// Also set on global for compatibility
if (typeof (global as any).crypto === 'undefined') {
    (global as any).crypto = globalThis.crypto;
}

console.log('✅ Crypto polyfill initialized for Node.js 16');