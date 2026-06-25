"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptField = exports.encryptField = exports.decryptRequest = exports.encryptResponse = void 0;
const crypto_js_1 = __importDefault(require("crypto-js"));
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-32-char-key-for-dev-only!';
const encryptResponse = (req, res, next) => {
    const originalJson = res.json;
    res.json = function (data) {
        if (req.headers['x-encrypt'] === 'true') {
            const encrypted = crypto_js_1.default.AES.encrypt(JSON.stringify(data), ENCRYPTION_KEY).toString();
            return originalJson.call(this, { encrypted });
        }
        return originalJson.call(this, data);
    };
    next();
};
exports.encryptResponse = encryptResponse;
const decryptRequest = (req, res, next) => {
    if (req.headers['x-encrypt'] === 'true' && req.body.encrypted) {
        try {
            const decrypted = crypto_js_1.default.AES.decrypt(req.body.encrypted, ENCRYPTION_KEY).toString(crypto_js_1.default.enc.Utf8);
            req.body = JSON.parse(decrypted);
        }
        catch (error) {
            return res.status(400).json({ error: 'Invalid encrypted data' });
        }
    }
    next();
};
exports.decryptRequest = decryptRequest;
const encryptField = (data) => {
    return crypto_js_1.default.AES.encrypt(data, ENCRYPTION_KEY).toString();
};
exports.encryptField = encryptField;
const decryptField = (encryptedData) => {
    const decrypted = crypto_js_1.default.AES.decrypt(encryptedData, ENCRYPTION_KEY).toString(crypto_js_1.default.enc.Utf8);
    return decrypted;
};
exports.decryptField = decryptField;
//# sourceMappingURL=encryption.js.map