// backend/src/middleware/encryption.ts
import { Request, Response, NextFunction } from 'express';
import CryptoJS from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-32-char-key-for-dev-only!';

export const encryptResponse = (req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json;

    res.json = function (data: any) {
        if (req.headers['x-encrypt'] === 'true') {
            const encrypted = CryptoJS.AES.encrypt(
                JSON.stringify(data),
                ENCRYPTION_KEY
            ).toString();
            return originalJson.call(this, { encrypted });
        }
        return originalJson.call(this, data);
    };

    next();
};

export const decryptRequest = (req: Request, res: Response, next: NextFunction) => {
    if (req.headers['x-encrypt'] === 'true' && req.body.encrypted) {
        try {
            const decrypted = CryptoJS.AES.decrypt(
                req.body.encrypted,
                ENCRYPTION_KEY
            ).toString(CryptoJS.enc.Utf8);
            req.body = JSON.parse(decrypted);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid encrypted data' });
        }
    }
    next();
};

export const encryptField = (data: string): string => {
    return CryptoJS.AES.encrypt(data, ENCRYPTION_KEY).toString();
};

export const decryptField = (encryptedData: string): string => {
    const decrypted = CryptoJS.AES.decrypt(encryptedData, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);
    return decrypted;
};