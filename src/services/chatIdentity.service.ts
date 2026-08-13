import { executeQuery } from '../config/database';

function toInt(val: any): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = parseInt(val, 10);
    return isNaN(n) ? undefined : n;
}

const cache = new Map<number, { id: number; ts: number }>();
const TTL = 5 * 60 * 1000;

// Resolves a user identity (users.ID or cuserid) to the canonical users.ID.
// This is needed because .NET JWTs carry the login name (cuserid) as the id claim,
// while chat rows reference users.ID.
export async function resolveUserId(raw: any): Promise<number | undefined> {
    const num = toInt(raw);
    if (num === undefined) return undefined;

    const hit = cache.get(num);
    if (hit && Date.now() - hit.ts < TTL) return hit.id;

    try {
        const rows = await executeQuery<any>(
            `SELECT TOP 1 ID FROM users WHERE ID = @num OR cuserid = @num`,
            { num }
        );
        if (rows && rows.length > 0) {
            const resolved = toInt(rows[0].ID) ?? num;
            cache.set(num, { id: resolved, ts: Date.now() });
            return resolved;
        }
        // User not found: do not cache; the input value is used as-is downstream.
        return num;
    } catch (err) {
        // DB failure: do not poison the cache with the raw value, so a transient
        // error does not cause wrong user rooms / identity for the next 5 minutes.
        return num;
    }
}
