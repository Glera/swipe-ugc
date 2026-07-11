export const EXPERIMENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const CSP_MARKER = 'data-swipe-experiment-csp="1"';

export function hardenExperimentHtml(html) {
  if (typeof html !== 'string' || !/<head(?:\s[^>]*)?>/i.test(html)) throw new Error('experiment HTML has no head element');
  if (html.includes(CSP_MARKER)) return html;
  const meta = `<meta ${CSP_MARKER} http-equiv="Content-Security-Policy" content="${EXPERIMENT_CSP}">`;
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n  ${meta}`);
}

export function assertHardenedExperimentHtml(html) {
  if (!String(html).includes(CSP_MARKER) || !String(html).includes("connect-src 'none'")) {
    throw new Error('experiment artifact is missing the enforced network-deny CSP');
  }
}

export async function installExternalNetworkDeny(page, allowedOrigin, attempts) {
  const allowed = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === allowedOrigin || parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:';
    } catch {
      return false;
    }
  };
  page.on('request', (request) => {
    if (!allowed(request.url())) attempts.push(`${request.method()} ${request.url()}`);
  });
  await page.route('**', async (route) => {
    if (allowed(route.request().url())) await route.continue();
    else await route.abort('blockedbyclient');
  });
}
