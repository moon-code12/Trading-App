// A random id kept in this browser, so the server can recognise a familiar device (and flag a new one).
function deviceId() {
  let id = localStorage.getItem('deviceId');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('deviceId', id); }
  return id;
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem('token');
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-device-id': deviceId(), ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { data, status: res.status });
  return data;
}

export const money = (n, cur = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 }).format(n ?? 0);

// Fetches an authenticated file and hands it to the browser as a download.
export async function download(path, fallbackName) {
  const token = localStorage.getItem('token');
  const res = await fetch('/api' + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Download failed');
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const signedPct = (n) => `${n >= 0 ? '+' : ''}${(n ?? 0).toFixed(2)}%`;

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
export const compact = (n) => compactFmt.format(n ?? 0);
export const compactUsd = (n) => `$${compact(n)}`;
