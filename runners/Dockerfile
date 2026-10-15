FROM node:22-bookworm-slim
WORKDIR /opt/lunatv-runner
COPY runners/gateway.mjs runners/cat-host.cjs ./
RUN npm install --ignore-scripts --no-audit --no-fund --no-save --package-lock=false ajv@8.17.1 ajv-formats@3.0.1 fast-json-stringify@6.0.1 \
    && mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 RUNNER_CONFIG=/data/config.json
EXPOSE 8787
CMD ["node", "gateway.mjs"]
