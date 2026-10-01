import { z } from 'zod'

// Messages de validation zod en français (outils MCP, réglages, environnement) : configuration
// globale, appliquée dès qu'un module l'importe.
z.config(z.locales.fr())
