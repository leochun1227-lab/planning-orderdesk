// Do not expose proxy HTML or JSON parser internals to the user.
export async function readApiResponse(response) {
  const text = await response.text();
  if (response.status === 401 || response.redirected && /\/login(?:[/?#]|$)/.test(response.url)) {
    throw new Error('登录已失效，请刷新页面重新登录。 / Session expired. Refresh and sign in again.');
  }
  try { return JSON.parse(text); }
  catch {
    throw new Error(`服务返回异常（HTTP ${response.status}），请刷新查看排产结果；确认结果前请勿重复提交。 / Unexpected server response (HTTP ${response.status}). Refresh to check the result before submitting again.`);
  }
}
