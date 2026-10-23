import { createHash } from 'node:crypto';
export const hash = (token: string) => createHash('sha256').update(token).digest('hex');
