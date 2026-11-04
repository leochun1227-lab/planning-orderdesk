import { redirect } from 'next/navigation';
import { getUser } from '@/lib/auth';
import { authConfigured, safeReturnTo } from '@/lib/auth-session.mjs';

export const dynamic = 'force-dynamic';
export default async function LoginPage({ searchParams }: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo);
  if (await getUser()) redirect(returnTo);
  const configured = authConfigured();
  return <main className="login-page">
    <section className="login-card" aria-labelledby="login-title">
      <div className="login-brand">REGENT RV <span>PLANNING</span></div>
      <h1 id="login-title">登录 Orderdesk</h1>
      <p className="login-description">使用团队密码访问订单工作台。<br />Sign in with your team password.</p>
      {!configured && <p role="alert" className="login-error">登录尚未配置，请联系网站管理员。<br />Website sign-in is not configured yet.</p>}
      {params.error === 'invalid' && <p role="alert" className="login-error">密码不正确，请重试。 / Incorrect password.</p>}
      <form action="/api/auth/login" method="post">
        <input type="hidden" name="returnTo" value={returnTo} />
        <label htmlFor="password">团队密码 / Team password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={512} autoFocus disabled={!configured} />
        <button type="submit" disabled={!configured}>登录 / Sign in</button>
      </form>
      <p className="login-note">仅供授权的 Planning 团队成员使用。<br />For authorised Planning team members.</p>
    </section>
  </main>;
}
