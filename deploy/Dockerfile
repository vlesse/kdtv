# The TV app is built here rather than uploaded, so what runs on the server is
# always what is in the source tree next to it.
FROM node:22-alpine AS web
WORKDIR /w
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY bff/package.json bff/package-lock.json* ./
RUN npm ci --omit=dev
COPY bff/src ./src
COPY --from=web /w/dist ./web-dist

ENV NODE_ENV=production
ENV WEB_DIST=/app/web-dist
ENV DB_FILE=/data/ott.db
ENV MEDIA_DIR=/data/media
EXPOSE 9081
CMD ["node", "src/server.js"]
