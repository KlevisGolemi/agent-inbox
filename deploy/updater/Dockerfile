# Sidecar de mise à jour optionnel (voir deploy/updater/server.mjs).
FROM node:24-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY server.mjs ./

# Tourne en root volontairement : le socket Docker monté (/var/run/docker.sock) n'est
# accessible qu'à root ou au groupe docker dont le GID varie selon l'hôte ; un utilisateur
# non privilégié ne pourrait pas piloter Docker. Le risque est contenu : l'updater n'écoute
# que sur le réseau interne, n'expose qu'un seul endpoint protégé par secret et n'exécute
# qu'une commande fixe, sans shell.
EXPOSE 8081
CMD ["node", "server.mjs"]
