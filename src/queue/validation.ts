/** Identifiant de corrélation : une seule constante pour toute l'application. */
export const CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/

/** Nom de topic : même motif que l'identifiant de corrélation. */
export const TOPIC_REGEX = CORRELATION_ID_REGEX
