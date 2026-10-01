import type { Response } from 'express'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Échappe une valeur pour l'insérer dans du HTML (contenu ou attribut entre guillemets). */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f4f5f7;color:#1c1e21}
main{max-width:26rem;margin:8vh auto;padding:2rem;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:1.4rem;margin:0 0 1rem}
label{display:block;font-weight:600;margin:1rem 0 .3rem}
input{width:100%;padding:.6rem .7rem;font:inherit;border:1px solid #c4c8cf;border-radius:8px}
input:focus{outline:2px solid #2f6feb;outline-offset:1px}
button{margin-top:1.4rem;width:100%;padding:.7rem;font:inherit;font-weight:600;color:#fff;background:#2f6feb;border:0;border-radius:8px;cursor:pointer}
.error{padding:.7rem .9rem;border-radius:8px;background:#fdecea;color:#8a1c12}
.hint{font-size:.875rem;color:#5b616b}
@media (prefers-color-scheme:dark){
body{background:#16181c;color:#e6e8eb}main{background:#22252a;box-shadow:none}
input{background:#16181c;color:inherit;border-color:#454a52}.hint{color:#a0a6b0}.error{background:#4a1d19;color:#ffd7d2}}
`

/** Page HTML autonome (CSS inline, aucune ressource externe). `bodyHtml` doit être déjà échappé. */
export function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Cowork Queue</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</main>
</body>
</html>`
}

/** Envoie une page avec une CSP stricte (styles inline uniquement) et sans cache. */
export function sendPage(res: Response, status: number, title: string, bodyHtml: string): void {
  res
    .status(status)
    .set({
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'Cache-Control': 'no-store',
    })
    .type('html')
    .send(renderPage(title, bodyHtml))
}

const errorBlock = (error?: string) =>
  error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`

export function loginBody(o: {
  csrf: string
  email?: string
  next?: string
  error?: string
}): string {
  return `${errorBlock(o.error)}
<form method="post" action="/login">
${hidden('_csrf', o.csrf)}
${hidden('next', o.next ?? '')}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(o.email ?? '')}">
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Se connecter</button>
</form>`
}

export function setupBody(o: { csrf: string; email?: string; error?: string }): string {
  return `${errorBlock(o.error)}
<p class="hint">Saisissez le code de configuration affiché dans les journaux du serveur, puis créez le compte administrateur.</p>
<form method="post" action="/setup">
${hidden('_csrf', o.csrf)}
<label for="code">Code de configuration</label>
<input id="code" name="code" autocomplete="off" required spellcheck="false" aria-describedby="code-hint">
<p id="code-hint" class="hint">6 groupes de 4 caractères, par exemple ABCD-EFGH-…</p>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(o.email ?? '')}">
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required aria-describedby="pw-hint">
<p id="pw-hint" class="hint">Au moins 12 caractères.</p>
<button type="submit">Créer le compte</button>
</form>`
}
