import { handleLogout } from '@/lib/auth-session.mjs';
export const runtime = 'nodejs';
export async function POST(request: Request) { return handleLogout(request); }
