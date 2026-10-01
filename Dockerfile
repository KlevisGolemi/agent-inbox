# syntax=docker/dockerfile:1

# ── Étape de build : compile TypeScript + CSS, puis ne garde que les dépendances de production.
FROM node:24-alpine AS build
# Outils nécessaires uniquement à la compilation native de better-sqlite3.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY public ./public
# `npm run build` enchaîne build:css (public/app.css) puis tsc (dist/).
RUN npm run build && npm prune --omit=dev

# ── Étape d'exécution : aucun outil de build, utilisateur non-root.
FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/KlevisGolemi/cowork-communication" \
      org.opencontainers.image.title="Cowork Queue" \
      org.opencontainers.image.description="File d'attente auto-hébergée + MCP + OAuth + interface d'administration" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
# /data appartient à `node` avant la déclaration du volume : un volume neuf hérite de ces droits.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
