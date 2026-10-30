# syntax=docker/dockerfile:1

# 1) Access exporter (Java + Jackcess) -> /src/exporter/target/access-exporter.jar
FROM maven:3.9-eclipse-temurin-21 AS exporter
WORKDIR /src/exporter
COPY exporter/pom.xml .
RUN mvn -q dependency:go-offline
COPY exporter/src ./src
RUN mvn -q package -DskipTests

# 2) Web app + API server (TypeScript)
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build && npm prune --omit=dev

# 3) Runtime: Node + a Java runtime for the exporter
FROM node:22-bookworm-slim
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}" \
    NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/shared/package.json ./shared/package.json
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/web/dist ./web/dist
COPY --from=exporter /src/exporter/target/access-exporter.jar ./exporter/target/access-exporter.jar
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The entrypoint makes the data directory writable (hosted disks often mount as root),
# then runs the app as the unprivileged "node" user.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/dist/server/src/index.js"]
