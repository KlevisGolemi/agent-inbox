import type { FileCategory } from '../files/types.js'

export const DROP_TEXT_MAX_BYTES = 10 * 1024

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

/** CSP de la page de dépôt : aucun tiers, un seul script inline (nonce), envoi vers la même origine. */
export function dropPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    "img-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#1f2937}
#zone{border:2px dashed #9ca3af;border-radius:.75rem;padding:2rem;text-align:center}#zone.over{border-color:#2563eb}
textarea{width:100%;min-height:5rem}button{margin-top:1rem;padding:.6rem 1.2rem}small{color:#6b7280}`

/** Page neutre : identique pour un lien invalide, expiré, révoqué ou épuisé. */
export const UNAVAILABLE_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Lien indisponible</title><style>${STYLE}</style></head>
<body><h1>Lien indisponible</h1><p>Ce lien de dépôt n’est pas ou plus utilisable. Demandez un nouveau lien à votre interlocuteur.</p></body></html>`

export function renderDropPage(v: {
  label: string
  remaining: number
  maxFileMb: number
  categories: readonly FileCategory[]
  expiresAt: number
  nonce: string
}): string {
  const until = new Date(v.expiresAt).toLocaleString('fr-FR', { timeZone: 'UTC' }) + ' UTC'
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Déposer des fichiers</title><style>${STYLE}</style></head><body>
<h1>${escapeHtml(v.label)}</h1>
<p><small>${v.remaining} fichier(s) au plus · ${v.maxFileMb} Mo par fichier · types : ${escapeHtml(v.categories.join(', '))} · lien valable jusqu’au ${escapeHtml(until)}</small></p>
<form id="f" method="post" enctype="multipart/form-data">
<div id="zone"><p>Glissez vos fichiers ici, ou</p><input id="files" type="file" name="file" multiple required></div>
<p><label for="text">Message (facultatif, 10 Ko au plus)</label><textarea id="text" name="text" maxlength="10000"></textarea></p>
<button type="submit">Envoyer</button></form><p id="msg" role="status"></p>
<script nonce="${v.nonce}">
const z=document.getElementById('zone'),i=document.getElementById('files'),f=document.getElementById('f'),m=document.getElementById('msg');
z.addEventListener('dragover',e=>{e.preventDefault();z.classList.add('over')});
z.addEventListener('dragleave',()=>z.classList.remove('over'));
z.addEventListener('drop',e=>{e.preventDefault();z.classList.remove('over');i.files=e.dataTransfer.files});
f.addEventListener('submit',async e=>{e.preventDefault();m.textContent='Envoi en cours…';
try{const r=await fetch(location.href,{method:'POST',body:new FormData(f)});const d=await r.json().catch(()=>({}));
m.textContent=r.ok?'Merci, vos fichiers ont bien été déposés.':(d.message||'Envoi refusé ('+r.status+').');if(r.ok)f.reset()}
catch{m.textContent='Envoi impossible : vérifiez votre connexion.'}});
</script></body></html>`
}
