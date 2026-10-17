FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN bun install --frozen-lockfile --production
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "run", "apps/elves/src/index.ts"]
