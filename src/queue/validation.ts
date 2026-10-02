/** Identifiant de corrélation : une seule constante pour toute l'application. */
export const CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

/** Nom de topic : même motif que l'identifiant de corrélation. */
export const TOPIC_REGEX = CORRELATION_ID_REGEX

/** Nom de tag normalisé : minuscules, chiffres, tirets ; 48 caractères au plus. */
export const TAG_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,47}$/

/** Extension de fichier (sans point), en minuscules. */
export const EXTENSION_REGEX = /^[a-z0-9]{1,16}$/
