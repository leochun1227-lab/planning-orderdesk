import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, safeReturnTo, verifySession } from './auth-session.mjs';

export async function getUser() {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(returnTo = '/') {
  const user = await getUser();
  if (!user) redirect('/login?returnTo=' + encodeURIComponent(safeReturnTo(returnTo)));
  return user;
}
