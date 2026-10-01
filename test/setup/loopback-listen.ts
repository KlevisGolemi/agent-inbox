/**
 * Serveurs de test liés à 127.0.0.1 (jamais au joker `::`).
 *
 * Supertest démarre un serveur éphémère (`listen(0)`) par requête puis s'y connecte en
 * 127.0.0.1. Sur macOS, un serveur « joker » (`::`) obtient parfois un port déjà pris par un autre
 * processus lié à 127.0.0.1 précisément (Ollama sur 49152, OrbStack, outils de dev…) : le noyau
 * accepte les deux, et la connexion en 127.0.0.1 va au processus étranger. Résultat : réponse
 * d'un autre service (200 au lieu de 401/201/302…) ou `ECONNRESET`, de façon aléatoire et
 * surtout dans les gros fichiers de tests HTTP. Lié explicitement à 127.0.0.1, `listen(0)`
 * choisit un port libre pour cette adresse : plus de collision.
 *
 * Supertest lit `address()` juste après `listen(0)` ; `listen(0, '127.0.0.1')` résout l'hôte de
 * façon asynchrone (adresse encore nulle), d'où l'appel synchrone à `_listen2` (l'API que
 * `listen` utilise en interne). Si elle disparaît, on retombe sur le comportement d'origine.
 */
import http from 'node:http'

type Listen = (this: http.Server, ...args: unknown[]) => http.Server
type Internal = http.Server & {
  _listen2?: (addr: string, port: number, family: number, backlog: number) => void
}

const original = http.Server.prototype.listen as unknown as Listen

http.Server.prototype.listen = function (this: Internal, ...args: unknown[]) {
  const [port, cb, ...rest] = args
  if (port === 0 && rest.length === 0 && (cb === undefined || typeof cb === 'function')) {
    if (typeof this._listen2 === 'function' && !this.listening) {
      if (typeof cb === 'function') this.once('listening', cb as () => void)
      this._listen2('127.0.0.1', 0, 4, 511)
      return this
    }
  }
  return original.apply(this, args)
} as unknown as typeof http.Server.prototype.listen
